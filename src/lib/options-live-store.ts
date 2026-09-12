import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
import { OPTIONS_LIVE_ACCOUNT, optionsRequestFingerprint, type OwnedOptionsPosition } from "./options-live-policy";
import type { OptionsIntentRecord, OptionsLiveStore } from "./options-live-executor";
// Session advisory lock + AUTOCOMMITTED reservations. A broker acceptance must never
// be followed by rolling back the only durable record of its submission.
export class PostgresOptionsLiveStore implements OptionsLiveStore {
  private readonly context=new AsyncLocalStorage<PoolClient>();
  constructor(private readonly pool:Pool){}
  async initialize(){
    await this.pool.query(`CREATE TABLE IF NOT EXISTS options_live_intents (
      ref_id uuid PRIMARY KEY, account_number text NOT NULL, action text NOT NULL CHECK(action IN ('open','close')),
      state text NOT NULL CHECK(state IN ('submitting','unknown','accepted','settled')), payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX IF NOT EXISTS options_live_one_pending_action ON options_live_intents(account_number,action) WHERE state <> 'settled';
      CREATE TABLE IF NOT EXISTS options_live_owned_positions(position_id text PRIMARY KEY, account_number text NOT NULL, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`);
  }
  private client(){const client=this.context.getStore();if(!client)throw Error("Options ledger access requires the account lock");return client;}
  async withAccountLock<T>(account:string,work:()=>Promise<T>):Promise<T>{
    if(account!==OPTIONS_LIVE_ACCOUNT)throw Error("Wrong options account");
    if(this.context.getStore())throw Error("Nested options account lock refused");
    const client=await this.pool.connect();let locked=false,healthy=true;
    const onError=()=>{healthy=false;};client.on("error",onError);
    try{
      const result=await client.query<{locked:boolean}>("SELECT pg_try_advisory_lock(1472026,685528705) AS locked");
      locked=result.rows[0]?.locked===true;if(!locked)throw Error("Options account is busy");
      return await this.context.run(client,work);
    }finally{
      if(locked&&healthy)await client.query("SELECT pg_advisory_unlock(1472026,685528705)").catch(()=>{healthy=false;});
      client.removeListener("error",onError);client.release(!healthy);
    }
  }
  async getIntent(refId:string){const r=await this.client().query<{payload:OptionsIntentRecord}>("SELECT payload FROM options_live_intents WHERE ref_id=$1 AND account_number=$2",[refId,OPTIONS_LIVE_ACCOUNT]);return r.rows[0]?.payload??null;}
  async putIntent(record:OptionsIntentRecord){
    const prior=await this.getIntent(record.refId);
    assertDurableOptionsIntent(record,prior);
    await this.client().query(`INSERT INTO options_live_intents(ref_id,account_number,action,state,payload) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(ref_id) DO UPDATE SET state=EXCLUDED.state,payload=EXCLUDED.payload,updated_at=now()`,[record.refId,record.accountNumber,record.action,record.state,JSON.stringify(record)]);
  }
  async unsettledIntents(account:string){if(account!==OPTIONS_LIVE_ACCOUNT)throw Error("Wrong options account");const r=await this.client().query<{payload:OptionsIntentRecord}>("SELECT payload FROM options_live_intents WHERE account_number=$1 AND state<>'settled' ORDER BY updated_at",[account]);return r.rows.map(x=>x.payload);}
  async ownedPosition(id:string):Promise<OwnedOptionsPosition|null>{const r=await this.client().query<{payload:OwnedOptionsPosition}>("SELECT payload FROM options_live_owned_positions WHERE position_id=$1 AND account_number=$2",[id,OPTIONS_LIVE_ACCOUNT]);return r.rows[0]?.payload??null;}
}

export function assertDurableOptionsIntent(record:OptionsIntentRecord,prior:OptionsIntentRecord|null):void{
  const p=record.canonicalOrder,i=record.intent;
  if(record.accountNumber!==OPTIONS_LIVE_ACCOUNT||!p||!i||p.account_number!==OPTIONS_LIVE_ACCOUNT
    ||optionsRequestFingerprint(p)!==record.fingerprint||i.refId!==record.refId||i.action!==record.action||i.positionId!==record.positionId
    ||p.quantity!==String(i.quantity)||p.price!==i.limitPrice.toFixed(2)||p.legs.length!==i.legs.length
    ||p.legs.some((leg,n)=>leg.option_id!==i.legs[n].optionId||leg.side!==i.legs[n].side||leg.position_effect!==i.action||leg.ratio_quantity!==1))throw Error("Complete consistent canonical order required for recovery");
  if(prior&&(prior.fingerprint!==record.fingerprint||prior.action!==record.action||prior.positionId!==record.positionId
    ||JSON.stringify(prior.intent)!==JSON.stringify(record.intent)
    ||prior.order&&record.order?.id!==prior.order.id
    ||prior.state==="settled"&&record.state!=="settled"
    ||(record.maxFilledQuantity??0)<(prior.maxFilledQuantity??0)))throw Error("Durable identity or fill evidence cannot be overwritten");
}
