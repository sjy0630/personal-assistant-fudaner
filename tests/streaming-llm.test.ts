import { createServer, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAiCompatClient } from '../src/main/ai/llm';

let server: Server;
afterEach(async () => { server?.closeAllConnections(); if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });
async function fixture(handler: (res: ServerResponse, request: Record<string, unknown>) => void, model = 'fixture', kind: 'cloud' | 'local' = 'cloud') {
  server = createServer((req,res) => { let body=''; req.on('data',c=>body+=c); req.on('end',()=>handler(res,JSON.parse(body))); });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return new OpenAiCompatClient({baseURL:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,apiKey:'fixture',model},kind);
}
function frame(res: ServerResponse, delta: unknown, finish: string | null = null) { res.write(`data: ${JSON.stringify({id:'s',object:'chat.completion.chunk',created:0,model:'fixture',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`); }
function begin(res:ServerResponse){res.writeHead(200,{'content-type':'text/event-stream'});}
describe('真实 SSE 流',()=>{
  it.each(['DeepSeek-V4.1-Flash','deepseek-v4-pro','deepseek-flash','deepseek-chat'])('云端 %s 的主对话使用快速回复流式参数',async(model)=>{
    let request:Record<string,unknown>={};
    const client=await fixture((res,body)=>{request=body;begin(res);frame(res,{content:'收到'});frame(res,{},'stop');res.end('data: [DONE]\\n\\n'.replace(/\\n/g,'\n'));},model);
    await client.chat([],{onDelta:()=>{}});
    expect(request).toMatchObject({stream:true,thinking:{type:'disabled'}});
  });
  it.each([['fixture','cloud'],['deepseek-r1','cloud'],['deepseek-v4-flash','local']] as const)('%s / %s 不注入专属快速回复参数',async(model,kind)=>{
    let request:Record<string,unknown>={};
    const client=await fixture((res,body)=>{request=body;begin(res);frame(res,{content:'收到'});frame(res,{},'stop');res.end('data: [DONE]\n\n');},model,kind);
    await client.chat([],{onDelta:()=>{}});expect(request).not.toHaveProperty('thinking');
  });
  it('非流式的后台请求保留服务商原有模式',async()=>{
    let request:Record<string,unknown>={};
    const client=await fixture((res,body)=>{request=body;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]}));},'deepseek-v4-pro');
    await client.chat([]);expect(request).not.toHaveProperty('thinking');
  });
  it('首个分片在响应结束前可见，并重组完整正文',async()=>{
    let finish!:()=>void;let first!:()=>void;const gotFirst=new Promise<void>(r=>first=r);
    const client=await fixture((res,request)=>{expect(request.stream).toBe(true);begin(res);frame(res,{content:'你好'});finish=()=>{frame(res,{content:'，同学'});frame(res,{},'stop');res.end('data: [DONE]\n\n');};});
    const seen:string[]=[];let complete=false;
    const result=client.chat([{role:'user',content:'hi'}],{onDelta:(s:string)=>{seen.push(s);first();}} as never).then(r=>{complete=true;return r;});
    await gotFirst;expect(complete).toBe(false);expect(seen).toEqual(['你好']);finish();expect((await result).content).toBe('你好，同学');
  });
  it('工具调用按 index 重组名称、id 和 JSON 参数，不能把参数发成正文',async()=>{
    const client=await fixture((res)=>{begin(res);frame(res,{tool_calls:[{index:0,id:'call-a',type:'function',function:{name:'local__',arguments:'{"a":'}}]});frame(res,{tool_calls:[{index:0,function:{name:'query',arguments:'1}'}}]});frame(res,{},'tool_calls');res.end('data: [DONE]\n\n');});
    const chunks:string[]=[];const result=await client.chat([],{onDelta:(s:string)=>chunks.push(s)} as never);
    expect(chunks).toEqual([]);expect(result.toolCalls).toEqual([{id:'call-a',name:'local__query',arguments:'{"a":1}'}]);
  });
  it('AbortSignal 停止请求并保留停止前已经发出的正文',async()=>{
    const controller=new AbortController();const chunks:string[]=[];
    const client=await fixture(res=>{begin(res);frame(res,{content:'已经收到'});});
    await expect(client.chat([],{signal:controller.signal,onDelta:(s:string)=>{chunks.push(s);controller.abort();}} as never)).rejects.toThrow();
    expect(chunks).toEqual(['已经收到']);
  });
  it('未收到结束原因的断流不能冒充完整回复',async()=>{
    const client=await fixture(res=>{begin(res);frame(res,{content:'一半'});res.end();});
    await expect(client.chat([],{onDelta:()=>{}} as never)).rejects.toThrow();
  });
  it('长度截断不能执行未完成的工具参数',async()=>{
    const client=await fixture(res=>{begin(res);frame(res,{tool_calls:[{index:0,id:'a',function:{name:'tool',arguments:'{'}}]});frame(res,{},'length');res.end('data: [DONE]\n\n');});
    await expect(client.chat([],{onDelta:()=>{}} as never)).rejects.toThrow();
  });
});
