// Synthetic demo only. No Notion access, browser permissions, or real notifications.
const now=Date.now(),root='11111111111111111111111111111111',week='22222222222222222222222222222222';
const topics=['本周研发进展','产品需求与里程碑','接口设计说明','测试计划','上线检查清单','团队会议纪要'];
const editKey=n=>{const d=new Date(n),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;};
const pages=[{id:root,title:'团队周报',depth:0},{id:week,title:'本周周报',depth:1,parent:root},...topics.map((title,i)=>({id:String(i+3).repeat(32),title,depth:2,parent:week}))].map(p=>({...p,url:'https://app.notion.com/p/'+p.id,author:'小林',editKey:editKey(now-480000),lastAttemptAt:now-480000,lastSuccessfulAt:now-480000}));
let state={access:true,settings:{root:'https://app.notion.com/p/'+root,interval:60,concurrency:4,enabled:false,notify:false,recentOnly:true,incremental:true,collapseTabs:false},run:{status:'done',done:pages.length,failed:0,queue:[],startedAt:now-600000,heartbeat:now-480000,errors:[],seen:pages.map(p=>p.id)},pages,updates:topics.map((title,i)=>({id:'demo-'+i,pageId:pages[i+2].id,title,url:pages[i+2].url,author:['小林','小周','阿青'][i%3],kind:i===2?'discovered':'updated',editKey:editKey(now-(i+1)*900000),detectedAt:now-i*900000,notified:true,read:i===5}))};
try{const saved=JSON.parse(localStorage.getItem('notion-watch-synthetic-demo')||'null');if(saved){state.settings=saved.settings;for(const u of state.updates)u.read=!!saved.read?.includes(u.id);}}catch{}
const persist=()=>localStorage.setItem('notion-watch-synthetic-demo',JSON.stringify({settings:state.settings,read:state.updates.filter(u=>u.read).map(u=>u.id)}));
window.chrome={runtime:{getManifest:()=>({version:'0.2.0-demo'}),sendMessage:async m=>{
 if(m.type==='status')return structuredClone(state);
 if(m.type==='read'){for(const u of state.updates)if(m.ids.includes(u.id))u.read=true;persist();}
 if(m.type==='save'){state.settings=m.settings;persist();}
 if(m.type==='start'||m.type==='retry'){state.run.status='running';state.run.done=0;state.run.startedAt=Date.now();state.run.queue=[{}];setTimeout(()=>{if(state.run.status==='running'){state.run.status='done';state.run.queue=[];state.run.done=m.singlePage?1:pages.length;state.run.heartbeat=Date.now();}},8000);}
 if(m.type==='stop'){state.run.status='stopped';state.run.queue=[];state.run.heartbeat=Date.now();}
 return {ok:true};
}},permissions:{request:async()=>true}};
document.querySelector('.eyebrow').textContent='演示模式 · 合成数据，不连接 Notion';
