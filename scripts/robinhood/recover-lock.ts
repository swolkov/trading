// Explicit recovery only after proving the recorded process is gone. No credentials read.
import { open, readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { AUTH_DIR } from "./client";
async function main(){
  const recoveryPath=join(AUTH_DIR,"recovery.lock"),path=join(AUTH_DIR,"session.lock");
  const recovery=await open(recoveryPath,"wx",0o600);
  try{
    const before=await stat(path);const pid=Number(await readFile(path,"utf8"));if(!Number.isSafeInteger(pid)||pid<=0)throw Error("Invalid lock owner; manual inspection required");
    try{process.kill(pid,0);throw Error("Recorded process is still alive; lock retained");}catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH")throw e;}
    const after=await stat(path);if(before.ino!==after.ino||before.mtimeMs!==after.mtimeMs)throw Error("Lock changed; retained");
    await unlink(path);console.log("Removed lock owned by a process that no longer exists");
  }finally{await recovery.close();await unlink(recoveryPath);}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
