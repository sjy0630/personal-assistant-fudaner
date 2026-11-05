import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/main/db/db';
import { Repo } from '../src/main/db/repo';
const opened:Db[]=[];
afterEach(()=>opened.splice(0).forEach(db=>db.close()));
function setup(){const db=new Db(':memory:');opened.push(db);return new Repo(db);}
describe('持续对话游标分页',()=>{
  it('同一时间的消息跨页没有重复或遗漏，按原有顺序显示',()=>{
    const repo=setup();for(let i=0;i<125;i++)repo.addMessage({id:`m-${i}`,role:'assistant',content:`消息${i}`,createdAt:'2026-11-05T00:00:00Z'});
    const first=repo.messagePage();expect(first.messages).toHaveLength(50);expect(first.hasMore).toBe(true);expect(first.messages.at(-1)?.id).toBe('m-124');
    const second=repo.messagePage(first.messages[0].id);const third=repo.messagePage(second.messages[0].id);
    expect(second.hasMore).toBe(true);expect(third.hasMore).toBe(false);
    expect([...third.messages,...second.messages,...first.messages].map(m=>m.id)).toEqual(Array.from({length:125},(_,i)=>`m-${i}`));
  });
  it('不存在的游标返回空结果，不回到最新页造成重复',()=>{const repo=setup();repo.addMessage({role:'user',content:'新消息'});expect(repo.messagePage('missing')).toEqual({messages:[],hasMore:false});});
  it('无消息时为空；最近页和前一页按时间排序',()=>{
    const repo=setup();expect(repo.messagePage()).toEqual({messages:[],hasMore:false});
    repo.addMessage({id:'new',role:'user',content:'新',createdAt:'2026-11-05T10:00:00Z'});repo.addMessage({id:'old',role:'user',content:'旧',createdAt:'2026-11-04T10:00:00Z'});
    expect(repo.messagePage(undefined,1)).toMatchObject({hasMore:true,messages:[{id:'new'}]});expect(repo.messagePage('new',1)).toMatchObject({hasMore:false,messages:[{id:'old'}]});
  });
});
