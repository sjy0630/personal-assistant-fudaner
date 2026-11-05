import { writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { Db } from '../../src/main/db/db';
import { Repo } from '../../src/main/db/repo';
import { ChatAgent } from '../../src/main/ai/agent';
import { ModelRouter, OpenAiCompatClient, type AiTask, type LlmClient } from '../../src/main/ai/llm';
import type { McpHub } from '../../src/main/mcp/hub';
import { nullChannels } from '../../src/main/engine/channels';

it.runIf(process.env.EVAL_SUMMARY === '1')('本机模型50轮对话后仍能从滚动摘要回忆早期事实', async () => {
  const url = new URL(process.env.EVAL_BASE_URL || 'http://127.0.0.1:11434/v1');
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password) throw Error('Only local loopback endpoint is allowed');
  const config={baseURL:url.href,model:process.env.EVAL_MODEL || 'qwen2.5:7b',apiKey:''};
  const client=new OpenAiCompatClient(config,'local');
  const db=new Db(':memory:');const repo=new Repo(db);
  const started=performance.now();const requests:{summary:boolean;elapsedMs:number}[]=[];
  const bounded:LlmClient={label:client.label,async chat(messages,opts){
    const start=performance.now();try{return await client.chat(messages,{...opts,maxTokens:opts?.json?700:180,signal:AbortSignal.timeout(30_000)});}
    finally{requests.push({summary:!!opts?.json,elapsedMs:Math.round(performance.now()-start)});}
  }};
  class SummaryRouter extends ModelRouter { override for(task:AiTask){return task==='chat'?bounded:null;} }
  const router=new SummaryRouter(()=>repo.getSettings());
  const agent=new ChatAgent(repo,router,{llmTools:()=>[]} as unknown as McpHub,nullChannels);
  const prompts=['我想准备GRE，目标分数320；周二晚上有社团，不安排学习；报告尚未完成。这里只测试记忆，不要创建目标或调用工具，只回复“收到”。'];
  for(let i=1;i<49;i++)prompts.push(`这是记忆测试第${i+1}轮，只回复“收到”，不调用工具，不添加新安排。`);
  let final='';let summary='';let failure:string|undefined;
  try {
    for(let i=0;i<prompts.length;i++) {
      const reply=await agent.handleUserMessage(prompts[i]);
      if(/回复未完成|已停止生成/.test(reply.content)) throw Error('conversation_request_failed');
      if((i+1)%10===0){
        const waitUntil=performance.now()+12_000;
        while(repo.summaryBatch() && performance.now()<waitUntil)await pause(100);
        console.log(`已完成${i+1}轮，摘要${repo.latestSummary()?'已生成':'尚未生成'}。`);
      }
    }
    const waitUntil=performance.now()+12_000;
    while(repo.summaryBatch() && performance.now()<waitUntil)await pause(100);
    summary=repo.latestSummary()?.summary || '';
    final=(await agent.handleUserMessage('现在是第50轮：请回忆最早说过的GRE目标分数、周二晚安排、报告完成状态。只根据历史回答，三项分别说明。')).content;
  }catch{failure='local_summary_or_conversation_failed';}
  const checks={summaryCreated:!!summary,score:final.includes('320'),schedule:/社团/.test(final),unfinished:/未完成|没完成|没有完成|未交|尚未/.test(final),completed:!failure&&!/回复未完成|已停止生成/.test(final)};
  await writeFile(new URL('./summary-results.json',import.meta.url),JSON.stringify({generatedAt:new Date().toISOString(),model:client.label,rounds:50,executedChatCalls:requests.filter(r=>!r.summary).length,elapsedMs:Math.round(performance.now()-started),checks,summary,final,failure,requests,limitations:['Fictitious facts; in-memory Repo and the production ChatAgent/summary logic.','Tools disabled to isolate conversational retention; memory extraction disabled to ensure this tests rolling summaries, not the memory table.','Only a local-model smoke case, not a general factual recall benchmark.']},null,2)+'\n');
  // Background work can still finish; do not let it write into any persistent database.
  await pause(50);db.close();
  expect(Object.values(checks).every(Boolean),'详情见summary-results.json').toBe(true);
},300_000);
