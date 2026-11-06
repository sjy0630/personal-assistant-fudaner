import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import { ChatAgent } from '../src/main/ai/agent';
import type { LlmClient, ModelRouter } from '../src/main/ai/llm';
import type { McpHub } from '../src/main/mcp/hub';
import { nullChannels } from '../src/main/engine/channels';
import { assess } from '../src/main/engine/assess';
import type { Trigger } from '../src/shared/types';
const dbs:Db[]=[];afterEach(()=>dbs.splice(0).forEach(db=>db.close()));
function repo(){const db=new Db(':memory:');dbs.push(db);return new Repo(db);}
const hub={llmTools:()=>[]} as unknown as McpHub;
const result=(content:string)=>({content,toolCalls:[]});
describe('AI质量集成',()=>{
 it('早期摘要真实注入下一次ChatAgent系统提示',async()=>{
  const r=repo();for(let i=0;i<60;i++)r.addMessage({id:`h${i}`,role:i%2?'assistant':'user',content:`历史${i}`});r.addSummary('h39','用户GRE目标320，周二晚上有社团。');
  let system='';const llm:LlmClient={label:'fixture',chat:async(messages)=>{system=messages[0].content!;return result('目标320。');}};
  const router={for:(task:string)=>task==='chat'?llm:null} as ModelRouter;
  await new ChatAgent(r,router,hub,nullChannels).handleUserMessage('最初的目标是什么？');
  expect(system).toContain('早先对话摘要');expect(system).toContain('GRE目标320');
 });
 it('清空数据后异步记忆提取不再恢复旧数据',async()=>{
  const r=repo();let complete!:(value:ReturnType<typeof result>)=>void;
  const memory=new Promise<ReturnType<typeof result>>(resolve=>{complete=resolve;});
  const router={for:(task:string)=>task==='chat'?{label:'fixture',chat:async()=>result('收到。')}:task==='memory_extract'?{label:'fixture',chat:()=>memory}:null} as unknown as ModelRouter;
  await new ChatAgent(r,router,hub,nullChannels).handleUserMessage('我周二晚上有社团。');r.wipe();
  complete(result(JSON.stringify({memories:[{op:'add',type:'schedule',content:'周二晚上有社团',expires_days:null}]})));
  await new Promise(resolve=>setTimeout(resolve,0));expect(r.listMemories()).toEqual([]);expect(r.recentMessages()).toEqual([]);
 });
 it('非法研判动作不会进入引擎写回',async()=>{
  const trigger:Trigger={id:'t',source:'mail',kind:'mail_new',sourceRef:'m',threadKey:'mail:m',payload:{category:'other'},occurredAt:new Date().toISOString(),disposition:'pending'};
  const r=await assess([trigger],{llm:{label:'fixture',chat:async()=>result(JSON.stringify({value:1,urgency:1,action:'send_email',message_draft:'',reason:'invalid'}))},memories:[],phase:'regular',now:new Date(),describe:()=>''});
  expect(r.model).toBe('rules');expect(r.assessment.action).toBe('record');
 });
});
