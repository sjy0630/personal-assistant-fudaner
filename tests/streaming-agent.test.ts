import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
import { ChatAgent, runAgentLoop } from '../src/main/ai/agent';
import type { LlmClient, LlmOptions, ModelRouter } from '../src/main/ai/llm';
import type { McpHub } from '../src/main/mcp/hub';
import { nullChannels } from '../src/main/engine/channels';

const opened: Db[]=[];
afterEach(()=>opened.splice(0).forEach(db=>db.close()));
function setup(chat: LlmClient['chat']) {
  const db=new Db(':memory:');opened.push(db);const repo=new Repo(db);
  const snapshots: {id:string;content:string;version:number}[]=[];
  const client:LlmClient={label:'fixture',chat};
  const router={for:(task:string)=>task==='chat'?client:null} as ModelRouter;
  const hub={llmTools:()=>[]} as unknown as McpHub;
  const agent=new ChatAgent(repo,router,hub,{...nullChannels,delta:(s:unknown)=>snapshots.push(structuredClone(s) as never)} as never);
  return {repo,agent,snapshots};
}
describe('主对话流式生命周期',()=>{
  it('真实分片立即推送，最终只保存一条同 ID 助理回复',async()=>{
    const {repo,agent,snapshots}=setup(async(_messages,opts)=>{opts?.onDelta?.('你好');opts?.onDelta?.('，同学');return {content:'你好，同学',toolCalls:[]};});
    const result=await agent.handleUserMessage('hi');
    expect(snapshots.map(s=>s.content)).toContain('你好');expect(snapshots.at(-1)?.content).toBe(result.content);
    expect(snapshots[0].id).toBe(result.id);expect(repo.recentMessages(10).filter(m=>m.role==='assistant')).toHaveLength(1);
    expect(agent.state()).toBeNull();
  });
  it('断线保留已收到的内容，并且错误提示不回显服务端敏感信息',async()=>{
    const {agent}=setup(async(_m,opts)=>{opts?.onDelta?.('已经写出的内容');throw Error('secret-token-from-provider');});
    const result=await agent.handleUserMessage('hi');expect(result.content).toContain('已经写出的内容');expect(result.content).toContain('未完成');expect(result.content).not.toContain('secret-token');
  });
  it('可停止指定运行，保存部分回复并阻止并发请求混入同一条消息',async()=>{
    let started!:()=>void;const ready=new Promise<void>(r=>started=r);
    const {agent,repo}=setup(async(_m,opts)=>{opts?.onDelta?.('部分回复');started();await new Promise((_resolve,reject)=>opts!.signal!.addEventListener('abort',()=>reject(new Error('abort')),{once:true}));return {content:'',toolCalls:[]};});
    const pending=agent.handleUserMessage('first');await ready;
    const state=agent.state()!;expect(state.content).toBe('部分回复');
    await expect(agent.handleUserMessage('second')).rejects.toThrow();expect(repo.recentMessages().filter(m=>m.role==='user')).toHaveLength(1);
    agent.cancel('other');expect(agent.state()).not.toBeNull();agent.cancel(state.id);
    const reply=await pending;expect(reply.content).toContain('部分回复');expect(reply.content).toContain('已停止');expect(agent.state()).toBeNull();
  });
  it('跨工具轮显示真实正文，并区分同名工具的多次调用',async()=>{
    let turn=0;const text:string[]=[];
    const result=await runAgentLoop({
      llm:{label:'fixture',chat:async(_m,opts?:LlmOptions)=>{turn++;const content=turn===1?'先查询。':'查询完成。';opts?.onDelta?.(content);return {content,toolCalls:turn===1?[{id:'a',name:'local__query',arguments:'{}'},{id:'b',name:'local__query',arguments:'{}'}]:[]};}},
      hub:{call:async()=>({ok:true,text:'{}',server:'local',tool:'query'})} as unknown as McpHub,tools:[],messages:[],onDelta:(s:string)=>text.push(s),
    });
    expect(text.join('')).toBe('先查询。\n\n查询完成。');expect(result.content).toBe(text.join(''));expect(result.toolCalls.map(t=>t.id)).toEqual(['a','b']);
  });
});
