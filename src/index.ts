/**
 * Chatter3 Backend v3 — Cloudflare Worker
 * FP/RP points · Admin settings · Friends · Invites
 */
interface Env {
  DB: D1Database;
  SIGNALING: DurableObjectNamespace;
  RESEND_API_KEY: string;
}
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'};
const json=(d:any,s=200)=>Response.json(d,{status:s,headers:cors});
const uuid=()=>crypto.randomUUID();
const todayUTC=()=>new Date().toISOString().slice(0,10);

const DAILY_FP=1;
const RP_PER_COMPLETION=1;
const RP_PER_GOOD=0.5;
const RP_TO_FP=3;
const ADMIN_EMAILS=['dax@chatter3.com','john@chatter3.com'];
const REPORT_EMAIL='report@chatter3.com';
const FROM_EMAIL='noreply@chatter3.com';
const APP_URL='https://app.chatter3.com';

// ── Helpers ──────────────────────────────────────────────────
async function ensureDailyFP(db:D1Database,uid:string){
  const u:any=await db.prepare('SELECT fp_balance,fp_last_reset FROM users WHERE id=?').bind(uid).first();
  if(!u)return;
  if(u.fp_last_reset!==todayUTC())
    await db.prepare('UPDATE users SET fp_balance=?,fp_last_reset=? WHERE id=?').bind(DAILY_FP,todayUTC(),uid).run();
}
async function sendEmail(key:string,to:string,subject:string,html:string){
  if(!key)return;
  await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({from:FROM_EMAIL,to,subject,html})}).catch(()=>{});
}
async function requireAdmin(db:D1Database,uid:string){
  const u:any=await db.prepare('SELECT is_admin FROM users WHERE id=? AND is_admin=1').bind(uid).first();
  return !!u;
}

// Read all app settings as a typed object
async function getSettings(db:D1Database){
  const rows=await db.prepare('SELECT key,value FROM app_settings').all();
  const m:Record<string,string>={};
  for(const r of (rows.results||[]))m[(r as any).key]=(r as any).value;
  return{
    matchByLevel:  (m['matching_by_level']   ??('' ))==='true',
    matchDiffCountry:(m['matching_diff_country']??(''))==='true',
    matchDiffLang: (m['matching_diff_language']??(''))==='true',
    customDuration:parseInt(m['custom_call_duration']||'0'),
  };
}

// ── Signaling DO ─────────────────────────────────────────────
export class SignalingServer implements DurableObject{
  state:DurableObjectState;sessions:Set<WebSocket>;
  constructor(s:DurableObjectState){this.state=s;this.sessions=new Set();}
  async fetch(r:Request){
    if(r.headers.get('Upgrade')!=='websocket')return new Response('Expected websocket',{status:426});
    const{0:cl,1:sv}=new WebSocketPair();
    this.state.acceptWebSocket(sv);this.sessions.add(sv);
    return new Response(null,{status:101,webSocket:cl});
  }
  async webSocketMessage(ws:WebSocket,msg:string){
    for(const o of this.sessions){if(o!==ws)try{o.send(msg);}catch{this.sessions.delete(o);}}
  }
  async webSocketClose(ws:WebSocket){this.sessions.delete(ws);}
}

// ── Main Worker ───────────────────────────────────────────────
export default{
  async fetch(req:Request,env:Env):Promise<Response>{
    const url=new URL(req.url);const p=url.pathname;
    if(req.method==='OPTIONS')return new Response(null,{headers:cors});

    // ICE servers
    if(p==='/api/ice-servers'){
      try{const r=await fetch('https://chatter3.metered.live/api/v1/turn/credentials?apiKey=075477e7cb4cd90b70eb8fa70dbb4b7ab76a');return json({iceServers:await r.json()});}
      catch{return json({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});}
    }

    // Online stats with by_level
    if(p==='/api/stats/online'){
      const[q,s,bl]:any[]=await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as c FROM matching_queue').first(),
        env.DB.prepare("SELECT COUNT(*) as c FROM sessions WHERE status='active'").first(),
        env.DB.prepare('SELECT english_level,COUNT(*) as c FROM matching_queue GROUP BY english_level').all(),
      ]);
      const by_level:Record<string,number>={};
      for(const r of (bl.results||[]))by_level[(r as any).english_level]=(r as any).c;
      return json({searching:q?.c||0,in_call:(s?.c||0)*2,total:(q?.c||0)+(s?.c||0)*2,by_level});
    }

    // ── AUTH ───────────────────────────────────────────────────
    if(p==='/api/auth/google'&&req.method==='POST'){
      const{credential,ref}=await req.json() as any;
      try{
        const pts=credential.split('.');
        const pl=JSON.parse(atob(pts[1].replace(/-/g,'+').replace(/_/g,'/')));
        const email=pl.email,name=pl.name||email.split('@')[0],pic=pl.picture||'';
        const isAdmin=ADMIN_EMAILS.includes(email)?1:0;
        let user:any=await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
        if(!user){
          const id=uuid();
          await env.DB.prepare(`INSERT INTO users(id,username,email,password_hash,english_level,points,fp_balance,fp_last_reset,rp_balance,is_admin,created_at,avatar_url,nickname)VALUES(?,?,?,'google_oauth_user','beginner',0,?,?,0,?,datetime('now'),?,?)`).bind(id,name,email,DAILY_FP,todayUTC(),isAdmin,pic,name).run();
          user=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
          // Track invite usage
          if(ref){
            await env.DB.prepare("UPDATE invites SET used=1,invitee_id=? WHERE inviter_id=? AND used=0").bind(id,ref).run().catch(()=>{});
          }
        }else{
          if(isAdmin&&!user.is_admin)await env.DB.prepare('UPDATE users SET is_admin=1 WHERE id=?').bind(user.id).run();
          await ensureDailyFP(env.DB,user.id);
          user=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
        }
        return json({success:true,user});
      }catch{return json({success:false,error:'Invalid token'});}
    }

    if(p==='/api/auth/register'&&req.method==='POST'){
      const{email,username,english_level,country,native_language,ref}=await req.json() as any;
      const id=uuid();
      try{
        await env.DB.prepare(`INSERT INTO users(id,username,email,password_hash,english_level,points,fp_balance,fp_last_reset,rp_balance,country,native_language,created_at)VALUES(?,?,?,'email_user',?,0,?,?,0,?,?,datetime('now'))`).bind(id,username,email,english_level||'beginner',DAILY_FP,todayUTC(),country||'',native_language||'').run();
        if(ref)await env.DB.prepare("UPDATE invites SET used=1,invitee_id=? WHERE inviter_id=? AND used=0").bind(id,ref).run().catch(()=>{});
        const user=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
        return json({success:true,user});
      }catch{return json({success:false,error:'User already exists'});}
    }

    if(p==='/api/auth/login'&&req.method==='POST'){
      const{email}=await req.json() as any;
      const user:any=await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
      if(!user)return json({success:false,error:'User not found'});
      if(user.is_banned)return json({success:false,error:'Account suspended. Contact support.'});
      await ensureDailyFP(env.DB,user.id);
      return json({success:true,user:await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first()});
    }

    // ── USER ───────────────────────────────────────────────────
    if(p.startsWith('/api/user/balances/')){
      const uid=p.split('/').pop();
      await ensureDailyFP(env.DB,uid as string);
      const u:any=await env.DB.prepare('SELECT fp_balance,rp_balance FROM users WHERE id=?').bind(uid).first();
      return json({success:true,fp:u?.fp_balance??0,rp:u?.rp_balance??0});
    }

    if(p==='/api/user/exchange-rp'&&req.method==='POST'){
      const{user_id,quantity}=await req.json() as any;
      const qty=Math.max(1,parseInt(quantity)||1);
      const cost=qty*RP_TO_FP;
      await ensureDailyFP(env.DB,user_id);
      const u:any=await env.DB.prepare('SELECT fp_balance,rp_balance FROM users WHERE id=?').bind(user_id).first();
      if(!u)return json({success:false,error:'User not found'});
      if(u.rp_balance<cost)return json({success:false,error:`Need ${cost} RP (have ${u.rp_balance.toFixed(1)})`});
      await env.DB.prepare('UPDATE users SET rp_balance=rp_balance-?,fp_balance=fp_balance+? WHERE id=?').bind(cost,qty,user_id).run();
      const f:any=await env.DB.prepare('SELECT fp_balance,rp_balance FROM users WHERE id=?').bind(user_id).first();
      return json({success:true,fp:f.fp_balance,rp:f.rp_balance});
    }

    if(p==='/api/user/update'&&req.method==='POST'){
      const{id,nickname,country,native_language,english_level,bio,avatar_url}=await req.json() as any;
      await env.DB.prepare('UPDATE users SET nickname=?,country=?,native_language=?,english_level=?,bio=?,avatar_url=? WHERE id=?').bind(nickname,country,native_language,english_level,bio,avatar_url,id).run();
      return json({success:true,user:await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first()});
    }

    if(p==='/api/user/history'&&req.method==='POST'){
      const{user_id}=await req.json() as any;
      const h=await env.DB.prepare(`SELECT s.id,s.created_at,s.ended_at,s.duration,CASE WHEN s.user1_id=? THEN u2.username ELSE u1.username END as partner_name,CASE WHEN s.user1_id=? THEN u2.avatar_url ELSE u1.avatar_url END as partner_avatar,pt.points as points_earned FROM sessions s JOIN users u1 ON s.user1_id=u1.id JOIN users u2 ON s.user2_id=u2.id LEFT JOIN point_transactions pt ON pt.session_id=s.id AND pt.user_id=? AND pt.activity_type='video_call_reward' WHERE(s.user1_id=? OR s.user2_id=?)AND s.status='completed' ORDER BY s.created_at DESC LIMIT 20`).bind(user_id,user_id,user_id,user_id,user_id).all();
      return json({success:true,history:h.results});
    }

    if(p.startsWith('/api/user/')&&req.method==='GET'&&!p.includes('/balances')){
      const uid=p.split('/').pop();
      return json({success:true,user:await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(uid).first()});
    }

    // ── INVITE ─────────────────────────────────────────────────
    if(p==='/api/invite/create'&&req.method==='POST'){
      const{user_id}=await req.json() as any;
      const id=uuid();
      await env.DB.prepare("INSERT INTO invites(id,inviter_id,created_at)VALUES(?,?,datetime('now'))").bind(id,user_id).run();
      return json({success:true,invite_url:`${APP_URL}/?ref=${user_id}`,invite_id:id});
    }

    if(p==='/api/invite/stats'&&req.method==='POST'){
      const{user_id}=await req.json() as any;
      const total:any=await env.DB.prepare('SELECT COUNT(*) as c FROM invites WHERE inviter_id=?').bind(user_id).first();
      const used:any=await env.DB.prepare('SELECT COUNT(*) as c FROM invites WHERE inviter_id=? AND used=1').bind(user_id).first();
      return json({success:true,total:total?.c||0,used:used?.c||0});
    }

    // ── FRIENDS ────────────────────────────────────────────────
    if(p==='/api/friends/search'&&req.method==='POST'){
      const{user_id,query}=await req.json() as any;
      const q=`%${query||''}%`;
      const users=await env.DB.prepare(`SELECT id,username,nickname,avatar_url,country,english_level FROM users WHERE(username LIKE ? OR nickname LIKE ?)AND id!=? AND is_banned=0 LIMIT 20`).bind(q,q,user_id).all();
      return json({success:true,users:users.results});
    }

    if(p==='/api/friends/request'&&req.method==='POST'){
      const{sender_id,receiver_id}=await req.json() as any;
      if(sender_id===receiver_id)return json({success:false,error:"Can't add yourself"});
      const id=uuid();
      try{
        await env.DB.prepare("INSERT INTO friend_requests(id,sender_id,receiver_id,status,created_at)VALUES(?,?,?,'pending',datetime('now'))").bind(id,sender_id,receiver_id).run();
        // Notify receiver via email (best-effort)
        const[s,r]:any[]=await Promise.all([
          env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sender_id).first(),
          env.DB.prepare('SELECT email,username FROM users WHERE id=?').bind(receiver_id).first(),
        ]);
        if(r?.email)await sendEmail(env.RESEND_API_KEY,r.email,'[Chatter3] New Friend Request',`<p>${s?.username} sent you a friend request on Chatter3!</p><p><a href="${APP_URL}">Open Chatter3</a> to accept or decline.</p>`);
        return json({success:true});
      }catch{return json({success:false,error:'Request already sent or already friends'});}
    }

    if(p==='/api/friends/respond'&&req.method==='POST'){
      const{request_id,user_id,action}=await req.json() as any;
      const fr:any=await env.DB.prepare('SELECT * FROM friend_requests WHERE id=? AND receiver_id=?').bind(request_id,user_id).first();
      if(!fr)return json({success:false,error:'Request not found'});
      if(action==='accept'){
        const id1=uuid(),id2=uuid();
        await env.DB.batch([
          env.DB.prepare("UPDATE friend_requests SET status='accepted' WHERE id=?").bind(request_id),
          env.DB.prepare("INSERT OR IGNORE INTO friends(id,user_id,friend_id,created_at)VALUES(?,?,?,datetime('now'))").bind(id1,fr.sender_id,fr.receiver_id),
          env.DB.prepare("INSERT OR IGNORE INTO friends(id,user_id,friend_id,created_at)VALUES(?,?,?,datetime('now'))").bind(id2,fr.receiver_id,fr.sender_id),
        ]);
      }else{
        await env.DB.prepare("UPDATE friend_requests SET status='declined' WHERE id=?").bind(request_id).run();
      }
      return json({success:true});
    }

    if(p==='/api/friends/list'&&req.method==='POST'){
      const{user_id}=await req.json() as any;
      const friends=await env.DB.prepare(`SELECT u.id,u.username,u.nickname,u.avatar_url,u.country,u.english_level FROM friends f JOIN users u ON f.friend_id=u.id WHERE f.user_id=? ORDER BY u.username ASC`).bind(user_id).all();
      const pending=await env.DB.prepare(`SELECT fr.id,fr.sender_id,fr.created_at,u.username,u.nickname,u.avatar_url FROM friend_requests fr JOIN users u ON fr.sender_id=u.id WHERE fr.receiver_id=? AND fr.status='pending'`).bind(user_id).all();
      const sent=await env.DB.prepare(`SELECT fr.id,fr.receiver_id,fr.status,u.username FROM friend_requests fr JOIN users u ON fr.receiver_id=u.id WHERE fr.sender_id=?`).bind(user_id).all();
      return json({success:true,friends:friends.results,pending_requests:pending.results,sent_requests:sent.results});
    }

    if(p==='/api/friends/remove'&&req.method==='POST'){
      const{user_id,friend_id}=await req.json() as any;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM friends WHERE user_id=? AND friend_id=?').bind(user_id,friend_id),
        env.DB.prepare('DELETE FROM friends WHERE user_id=? AND friend_id=?').bind(friend_id,user_id),
      ]);
      return json({success:true});
    }

    // ── MATCHING ───────────────────────────────────────────────
    if(p==='/api/matching/join'&&req.method==='POST'){
      const{user_id,english_level,country,native_language}=await req.json() as any;
      await ensureDailyFP(env.DB,user_id);
      const caller:any=await env.DB.prepare('SELECT fp_balance,country,native_language,is_banned FROM users WHERE id=?').bind(user_id).first();
      if(!caller)return json({success:false,error:'User not found'});
      if(caller.is_banned)return json({success:false,error:'Account suspended'});
      if((caller.fp_balance||0)<1)return json({success:false,error:'insufficient_fp',fp:caller.fp_balance});

      // Read admin-controlled settings from DB
      const cfg=await getSettings(env.DB);
      const cCountry=(caller.country||country||'').trim().toLowerCase();
      const cLang=(caller.native_language||native_language||'').trim().toLowerCase();

      try{await env.DB.prepare("DELETE FROM matching_queue WHERE joined_at < datetime('now','-15 seconds')").run();}catch{}

      // Build WHERE clauses based on settings
      let strictQ=`SELECT mq.user_id FROM matching_queue mq JOIN users u ON mq.user_id=u.id WHERE u.is_banned=0 AND mq.user_id!=?`;
      const strictB:any[]=[user_id];
      if(cfg.matchByLevel){strictQ+=` AND mq.english_level=?`;strictB.push(english_level);}
      if(cfg.matchDiffCountry&&cCountry){strictQ+=` AND (?='' OR LOWER(COALESCE(u.country,''))!=?)`;strictB.push(cCountry,cCountry);}
      if(cfg.matchDiffLang&&cLang){strictQ+=` AND (?='' OR LOWER(COALESCE(u.native_language,''))!=?)`;strictB.push(cLang,cLang);}
      strictQ+=` AND mq.user_id NOT IN(SELECT blocked_id FROM user_blocks WHERE blocker_id=? UNION SELECT blocker_id FROM user_blocks WHERE blocked_id=?) ORDER BY mq.joined_at ASC LIMIT 1`;
      strictB.push(user_id,user_id);

      const match:any=await env.DB.prepare(strictQ).bind(...strictB).first();

      if(match){
        const sid=uuid();const pid=match.user_id as string;
        // Determine call duration — custom if set, otherwise level-based
        await env.DB.batch([
          env.DB.prepare("UPDATE users SET fp_balance=fp_balance-1 WHERE id=? AND fp_balance>=1").bind(user_id),
          env.DB.prepare("UPDATE users SET fp_balance=fp_balance-1 WHERE id=? AND fp_balance>=1").bind(pid),
          env.DB.prepare("INSERT INTO sessions(id,user1_id,user2_id,english_level,status,created_at)VALUES(?,?,?,?,'active',datetime('now'))").bind(sid,user_id,pid,english_level),
          env.DB.prepare('DELETE FROM matching_queue WHERE user_id=?').bind(pid),
          env.DB.prepare('DELETE FROM matching_queue WHERE user_id=?').bind(user_id),
        ]);
        return json({success:true,matched:true,session_id:sid,custom_duration:cfg.customDuration||0});
      }
      await env.DB.prepare("INSERT OR REPLACE INTO matching_queue(user_id,english_level,joined_at)VALUES(?,?,datetime('now'))").bind(user_id,english_level).run();
      return json({success:true,matched:false});
    }

    if(p==='/api/matching/leave'&&req.method==='POST'){
      const{user_id}=await req.json() as any;
      await env.DB.prepare('DELETE FROM matching_queue WHERE user_id=?').bind(user_id).run();
      return json({success:true});
    }

    if(p.startsWith('/api/matching/session/')){
      const uid=p.split('/').pop();
      const sess:any=await env.DB.prepare("SELECT * FROM sessions WHERE(user1_id=? OR user2_id=?)AND status='active' LIMIT 1").bind(uid,uid).first();
      if(!sess)return json({active_session:false});
      const pid=sess.user1_id===uid?sess.user2_id:sess.user1_id;
      const partner=await env.DB.prepare('SELECT id,username,nickname,english_level,avatar_url,country,native_language FROM users WHERE id=?').bind(pid).first();
      const cfg=await getSettings(env.DB);
      return json({active_session:true,session:{...sess,partner,custom_duration:cfg.customDuration||0}});
    }

    if(p==='/api/matching/end'&&req.method==='POST'){
      const{session_id,user_id,reason}=await req.json() as any;
      const sess:any=await env.DB.prepare('SELECT * FROM sessions WHERE id=?').bind(session_id).first();
      if(sess&&sess.status==='active'){
        const dur=Math.floor((Date.now()-new Date(sess.created_at).getTime())/1000);
        await env.DB.prepare("UPDATE sessions SET status='completed',ended_at=datetime('now'),duration=? WHERE id=?").bind(dur,session_id).run();
      }
      return json({success:true});
    }

    if(p==='/api/matching/rate'&&req.method==='POST'){
      const{session_id,user_id,rating}=await req.json() as any;
      const sess:any=await env.DB.prepare('SELECT * FROM sessions WHERE id=?').bind(session_id).first();
      if(!sess)return json({success:false,error:'Session not found'});
      const isU1=sess.user1_id===user_id;
      const field=isU1?'user1_rating':'user2_rating';
      const dur=Math.floor((Date.now()-new Date(sess.created_at).getTime())/1000);
      await env.DB.prepare(`UPDATE sessions SET ${field}=?,status='completed',duration=COALESCE(duration,?) WHERE id=?`).bind(rating,dur,session_id).run();
      const updated:any=await env.DB.prepare('SELECT * FROM sessions WHERE id=?').bind(session_id).first();
      if(updated.user1_rating&&updated.user2_rating){
        const now=new Date().toISOString().replace('T',' ').slice(0,19);
        const u1=updated.user1_id,u2=updated.user2_id;
        const u1rp=RP_PER_COMPLETION+(updated.user2_rating==='good'?RP_PER_GOOD:0);
        const u2rp=RP_PER_COMPLETION+(updated.user1_rating==='good'?RP_PER_GOOD:0);
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET rp_balance=rp_balance+? WHERE id=?').bind(u1rp,u1),
          env.DB.prepare('UPDATE users SET rp_balance=rp_balance+? WHERE id=?').bind(u2rp,u2),
          env.DB.prepare("INSERT INTO point_transactions(id,user_id,points,activity_type,session_id,created_at)VALUES(?,?,?,'video_call_reward',?,?)").bind(uuid(),u1,u1rp,session_id,now),
          env.DB.prepare("INSERT INTO point_transactions(id,user_id,points,activity_type,session_id,created_at)VALUES(?,?,?,'video_call_reward',?,?)").bind(uuid(),u2,u2rp,session_id,now),
        ]);
        return json({success:true,rp_awarded:isU1?u1rp:u2rp});
      }
      return json({success:true,message:'Rating saved. Waiting for partner.'});
    }

    // ── REPORT / BLOCK ─────────────────────────────────────────
    if(p==='/api/report'&&req.method==='POST'){
      const{reporter_id,reported_id,session_id,reason}=await req.json() as any;
      if(!reporter_id||!reported_id)return json({success:false,error:'Missing fields'});
      const id=uuid();
      const now=new Date().toISOString().replace('T',' ').slice(0,19);
      await env.DB.prepare("INSERT INTO user_reports(id,reporter_id,reported_id,session_id,reason,created_at)VALUES(?,?,?,?,?,?)").bind(id,reporter_id,reported_id,session_id||null,reason||'',now).run();
      const[rep,rpd]:any[]=await Promise.all([
        env.DB.prepare('SELECT username,email FROM users WHERE id=?').bind(reporter_id).first(),
        env.DB.prepare('SELECT username,email FROM users WHERE id=?').bind(reported_id).first(),
      ]);
      await sendEmail(env.RESEND_API_KEY,REPORT_EMAIL,`[Chatter3] Report — ${reason}`,`<h2>New Report</h2><p><b>Reporter:</b> ${rep?.username} (${rep?.email})</p><p><b>Reported:</b> ${rpd?.username} (${rpd?.email})</p><p><b>Reason:</b> ${reason}</p><p><b>Session:</b> ${session_id||'N/A'}</p><p><b>Time:</b> ${now} UTC</p><hr/><p><a href="${APP_URL}/admin">Admin Dashboard</a></p>`);
      return json({success:true});
    }

    if(p==='/api/block'&&req.method==='POST'){
      const{blocker_id,blocked_id}=await req.json() as any;
      if(!blocker_id||!blocked_id)return json({success:false,error:'Missing fields'});
      await env.DB.prepare("INSERT OR IGNORE INTO user_blocks(id,blocker_id,blocked_id,created_at)VALUES(?,?,?,datetime('now'))").bind(uuid(),blocker_id,blocked_id).run();
      return json({success:true});
    }

    // ── ADMIN ──────────────────────────────────────────────────
    if(p==='/api/admin/check'&&req.method==='POST'){
      const{user_id}=await req.json() as any;
      return json({is_admin:await requireAdmin(env.DB,user_id)});
    }

    // Admin: read settings
    if(p==='/api/admin/settings'&&req.method==='POST'){
      const{admin_id}=await req.json() as any;
      if(!await requireAdmin(env.DB,admin_id))return json({error:'Unauthorized'},403);
      const rows=await env.DB.prepare('SELECT key,value,updated_by,updated_at FROM app_settings').all();
      return json({success:true,settings:rows.results});
    }

    // Admin: update a setting
    if(p==='/api/admin/settings/update'&&req.method==='POST'){
      const{admin_id,key,value}=await req.json() as any;
      if(!await requireAdmin(env.DB,admin_id))return json({error:'Unauthorized'},403);
      const allowed=['matching_by_level','matching_diff_country','matching_diff_language','custom_call_duration'];
      if(!allowed.includes(key))return json({error:'Unknown setting'},400);
      await env.DB.prepare("INSERT INTO app_settings(key,value,updated_by,updated_at)VALUES(?,?,?,datetime('now'))ON CONFLICT(key)DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(key,value,admin_id).run();
      return json({success:true});
    }

    // Admin: stats
    if(p==='/api/admin/stats'&&req.method==='POST'){
      const{admin_id}=await req.json() as any;
      if(!await requireAdmin(env.DB,admin_id))return json({error:'Unauthorized'},403);
      const today=todayUTC(),monthStart=today.slice(0,7)+'-01';
      const[tu,dau,mau,ts,as2,qs,pr,nt]:any[]=await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as c FROM users').first(),
        env.DB.prepare('SELECT COUNT(DISTINCT user_id) as c FROM point_transactions WHERE created_at>=?').bind(today).first(),
        env.DB.prepare('SELECT COUNT(DISTINCT user_id) as c FROM point_transactions WHERE created_at>=?').bind(monthStart).first(),
        env.DB.prepare("SELECT COUNT(*) as c FROM sessions WHERE status='completed'").first(),
        env.DB.prepare("SELECT COUNT(*) as c FROM sessions WHERE status='active'").first(),
        env.DB.prepare('SELECT COUNT(*) as c FROM matching_queue').first(),
        env.DB.prepare("SELECT COUNT(*) as c FROM user_reports WHERE status='pending'").first(),
        env.DB.prepare('SELECT COUNT(*) as c FROM users WHERE created_at>=?').bind(today).first(),
      ]);
      const sbd=await env.DB.prepare("SELECT DATE(created_at) as day,COUNT(*) as c FROM sessions WHERE created_at>=DATE('now','-30 days') GROUP BY day ORDER BY day DESC LIMIT 30").all();
      return json({total_users:tu?.c||0,dau:dau?.c||0,mau:mau?.c||0,total_sessions:ts?.c||0,active_sessions:as2?.c||0,queue_size:qs?.c||0,pending_reports:pr?.c||0,new_users_today:nt?.c||0,sessions_by_day:sbd.results||[]});
    }

    // Admin: user search
    if(p==='/api/admin/users'&&req.method==='POST'){
      const{admin_id,query}=await req.json() as any;
      if(!await requireAdmin(env.DB,admin_id))return json({error:'Unauthorized'},403);
      const q=`%${query||''}%`;
      const users=await env.DB.prepare('SELECT id,username,nickname,email,english_level,fp_balance,rp_balance,is_admin,is_banned,ban_reason,country,native_language,created_at FROM users WHERE username LIKE ? OR email LIKE ? OR nickname LIKE ? ORDER BY created_at DESC LIMIT 50').bind(q,q,q).all();
      return json({success:true,users:users.results});
    }

    // Admin: user detail
    if(p.match(/^\/api\/admin\/user\/[^/]+$/)&&req.method==='POST'){
      const uid=p.split('/')[4];
      const{admin_id}=await req.json() as any;
      if(!await requireAdmin(env.DB,admin_id))return json({error:'Unauthorized'},403);
      const user=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(uid).first();
      const sessions=await env.DB.prepare(`SELECT s.id,s.created_at,s.duration,s.status,CASE WHEN s.user1_id=? THEN u2.username ELSE u1.username END as partner FROM sessions s JOIN users u1 ON s.user1_id=u1.id JOIN users u2 ON s.user2_id=u2.id WHERE s.user1_id=? OR s.user2_id=? ORDER BY s.created_at DESC LIMIT 20`).bind(uid,uid,uid).all();
      const[rm,rr]:any[]= await Promise.all([env.DB.prepare('SELECT COUNT(*) as c FROM user_reports WHERE reporter_id=?').bind(uid).first(),env.DB.prepare('SELECT COUNT(*) as c FROM user_reports WHERE reported_id=?').bind(uid).first()]);
      return json({success:true,user,sessions:sessions.results,reports_made:rm?.c||0,reports_received:rr?.c||0});
    }

    if(p.endsWith('/adjust')&&req.method==='POST'){
      const uid=p.split('/')[4];
      const{admin_id,fp_delta,rp_delta}=await req.json() as any;
      if(!await requireAdmin(env.DB,admin_id))return json({error:'Unauthorized'},403);
      if(fp_delta)await env.DB.prepare('UPDATE users SET fp_balance=MAX(0,fp_balance+?) WHERE id=?').bind(fp_delta,uid).run();
      if(rp_delta)await env.DB.prepare('UPDATE users SET rp_balance=MAX(0,rp_balance+?) WHERE id=?').bind(rp_delta,uid).run();
      return json({success:true,user:await env.DB.prepare('SELECT fp_balance,rp_balance FROM users WHERE id=?').bind(uid).first()});
    }

    if(p.endsWith('/ban')&&req.method==='POST'){
      const uid=p.split('/')[4];
      const{admin_id,reason}=await req.json() as any;
      if(!await requireAdmin(env.DB,admin_id))return json({error:'Unauthorized'},403);
      await env.DB.prepare('UPDATE users SET is_banned=1,ban_reason=? WHERE id=?').bind(reason||'Policy violation',uid).run();
      return json({success:true});
    }

    if(p.endsWith('/unban')&&req.method==='POST'){
      const uid=p.split('/')[4];
      const{admin_id}=await req.json() as any;
      if(!await requireAdmin(env.DB,admin_id))return json({error:'Unauthorized'},403);
      await env.DB.prepare("UPDATE users SET is_banned=0,ban_reason='' WHERE id=?").bind(uid).run();
      return json({success:true});
    }

    if(p==='/api/admin/reports'&&req.method==='POST'){
      const{admin_id,status}=await req.json() as any;
      if(!await requireAdmin(env.DB,admin_id))return json({error:'Unauthorized'},403);
      const reports=await env.DB.prepare(`SELECT r.*,u1.username as reporter_name,u2.username as reported_name,u2.email as reported_email FROM user_reports r JOIN users u1 ON r.reporter_id=u1.id JOIN users u2 ON r.reported_id=u2.id WHERE r.status=? ORDER BY r.created_at DESC LIMIT 100`).bind(status||'pending').all();
      return json({success:true,reports:reports.results});
    }

    if(p.match(/^\/api\/admin\/report\/[^/]+\/action$/)&&req.method==='POST'){
      const rid=p.split('/')[4];
      const{admin_id,action,note}=await req.json() as any;
      if(!await requireAdmin(env.DB,admin_id))return json({error:'Unauthorized'},403);
      await env.DB.prepare('UPDATE user_reports SET status=?,admin_note=? WHERE id=?').bind(action==='dismiss'?'reviewed':'actioned',note||'',rid).run();
      return json({success:true});
    }

    // ── SIGNAL ─────────────────────────────────────────────────
    if(p==='/api/signal'){
      const sid=url.searchParams.get('sessionId');
      if(!sid)return new Response('Missing sessionId',{status:400});
      return env.SIGNALING.get(env.SIGNALING.idFromName(sid)).fetch(req);
    }

    return new Response('Not Found',{status:404,headers:cors});
  },
};
