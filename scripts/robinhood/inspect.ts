import { RobinhoodReadClient, withCredentialLock } from "./client";
withCredentialLock(async()=>{const c=new RobinhoodReadClient();await c.connect();const tools=await c.listTools();console.log(JSON.stringify(tools));}).catch(e=>{console.error(e.message);process.exitCode=1});
