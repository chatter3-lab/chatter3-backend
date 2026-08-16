/**
 * Chatter3 Backend v3 — Cloudflare Worker
 * FP/RP points · Admin settings · Friends · Invites
 */
interface Env {
  DB: D1Database;
  SIGNALING: DurableObjectNamespace;
  RESEND_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  SESSION_SECRET: string;
  METERED_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
}
const ALLOWED_ORIGIN='https://app.chatter3.com';
const cors={'Access-Control-Allow-Origin':ALLOWED_ORIGIN,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Credentials':'true'};
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

// ── Password hashing (PBKDF2 via Web Crypto) ───────────────
async function hashPassword(password:string):Promise<string>{
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const enc=new TextEncoder();
  const key=await crypto.subtle.importKey('raw',enc.encode(password),{name:'PBKDF2'},false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},key,256);
  const hash=new Uint8Array(bits);
  const toB64=(b:Uint8Array)=>btoa(String.fromCharCode(...b));
  return `pbkdf2$100000$${toB64(salt)}$${toB64(hash)}`;
}
async function verifyPassword(password:string,stored:string):Promise<boolean>{
  if(!stored||!stored.startsWith('pbkdf2$'))return false;
  const parts=stored.split('$');
  if(parts.length!==4)return false;
  const [,iterStr,b64salt,b64hash]=parts;
  const iter=parseInt(iterStr);
  const salt=Uint8Array.from(atob(b64salt),c=>c.charCodeAt(0));
  const enc=new TextEncoder();
  const key=await crypto.subtle.importKey('raw',enc.encode(password),{name:'PBKDF2'},false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:iter,hash:'SHA-256'},key,256);
  const hash=new Uint8Array(bits);
  const toB64=(b:Uint8Array)=>btoa(String.fromCharCode(...b));
  return toB64(hash)===b64hash;
}
function isLegacyPassword(hash:string):boolean{
  return !hash||hash==='email_user'||hash==='google_oauth_user'||hash==='admin_created'||!hash.startsWith('pbkdf2$');
}

// ── Turnstile verification (fail-closed) ──────────────────
async function verifyTurnstile(token:string,secretKey:string,ip?:string):Promise<boolean>{
  if(!secretKey)return false;
  if(!token)return false;
  const body=new URLSearchParams({secret:secretKey,response:token});
  if(ip)body.append('remoteip',ip);
  try{
    const r=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body});
    const d=await r.json() as any;
    return d.success===true;
  }catch{return false;}
}

// ── Session tokens (HMAC-SHA256) ─────────────────────────
const B64_CHARS='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64url(buf:ArrayBuffer):string{
  const bytes=new Uint8Array(buf);
  let out='';
  for(let i=0;i<bytes.length;i+=3){
    const a=bytes[i],b=i+1<bytes.length?bytes[i+1]:0,c=i+2<bytes.length?bytes[i+2]:0;
    out+=B64_CHARS[(a>>2)&63];
    out+=B64_CHARS[((a&3)<<4)|((b>>4)&15)];
    if(i+1<bytes.length)out+=B64_CHARS[((b&15)<<2)|((c>>6)&3)];
    if(i+2<bytes.length)out+=B64_CHARS[c&63];
  }
  return out.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function base64urlDecode(s:string):Uint8Array{
  let pad=s.replace(/-/g,'+').replace(/_/g,'/');
  while(pad.length%4)pad+='=';
  const out:number[]=[];
  for(let i=0;i<pad.length;i+=4){
    const a=B64_CHARS.indexOf(pad[i]);
    const b=B64_CHARS.indexOf(pad[i+1]);
    const c=pad[i+2]==='='?-1:B64_CHARS.indexOf(pad[i+2]);
    const d=pad[i+3]==='='?-1:B64_CHARS.indexOf(pad[i+3]);
    out.push(((a<<2)&255)|((b>>4)&3));
    if(c!==-1)out.push(((b<<4)&255)|((c>>2)&15));
    if(d!==-1)out.push(((c<<6)&255)|(d&63));
  }
  return new Uint8Array(out);
}
async function createSessionToken(env:Env,userId:string,isAdmin:boolean):Promise<string>{
  const header=base64url(new TextEncoder().encode(JSON.stringify({alg:'HS256',typ:'JWT'})));
  const payload=base64url(new TextEncoder().encode(JSON.stringify({sub:userId,admin:isAdmin,exp:Date.now()+86400000*30})));
  const data=`${header}.${payload}`;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(data));
  return `${data}.${base64url(sig)}`;
}
async function verifySessionToken(env:Env,token:string):Promise<{userId:string;isAdmin:boolean}|null>{
  try{
    const parts=token.split('.');
    if(parts.length!==3)return null;
    const[header,payload,sigB64]=parts;
    const data=`${header}.${payload}`;
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    const sig=base64urlDecode(sigB64);
    const valid=await crypto.subtle.verify('HMAC',key,sig,new TextEncoder().encode(data));
    if(!valid)return null;
    const payloadObj=JSON.parse(new TextDecoder().decode(base64urlDecode(payload)));
    if(payloadObj.exp&&payloadObj.exp<Date.now())return null;
    return{userId:payloadObj.sub,isAdmin:!!payloadObj.admin};
  }catch{return null;}
}
async function requireAuth(env:Env,req:Request):Promise<{userId:string;isAdmin:boolean}|Response>{
  const auth=req.headers.get('Authorization');
  if(!auth||!auth.startsWith('Bearer '))return json({success:false,error:'Authentication required'},401);
  const session=await verifySessionToken(env,auth.slice(7));
  if(!session)return json({success:false,error:'Invalid or expired session'},401);
  return session;
}

// ── Constant-time string comparison ───────────────────────
function timingSafeEqual(a:string,b:string):boolean{
  if(a.length!==b.length)return false;
  let diff=0;
  for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}

// ── HTML escape for email content ─────────────────────────
function esc(s:string):string{
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Strip sensitive fields from user object ───────────────
function sanitizeUser(u:any):any{
  if(!u)return u;
  const{password_hash:_,...safe}=u;
  safe.auth_provider=(_==='google_oauth_user')?'google':'email';
  return safe;
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
    promoFpFreeDays:parseInt(m['promo_fp_free_days']||'0'),
    promoInitialRp:parseInt(m['promo_initial_rp']||'0'),
    promoBadgeDays:parseInt(m['promo_badge_days']||'0'),
    newMemberDays:parseInt(m['new_member_days']||'30'),
    mvpMode:(m['mvp_mode']??'')==='true',
    maintenanceMode:(m['maintenance_mode']??'')==='true',
    maintenanceMessage:m['maintenance_message']||'We are currently performing maintenance. Please check back later.',
  };
}

// Check if a user is a founding member (flag set at registration for first 100, or admin override)
function isFoundingMember(override?:number){
  return !!override;
}
// Check if user is in FP free period
function inFpFreePeriod(created_at:any,promoFpFreeDays:number){
  if(!promoFpFreeDays||!created_at)return false;
  const age=Date.now()-new Date(created_at).getTime();
  return age<promoFpFreeDays*86400000;
}
// Check if user is a new member (within first N days of registration)
function isNewMember(created_at:any,newMemberDays:number){
  if(!created_at||!newMemberDays)return false;
  const age=Date.now()-new Date(created_at).getTime();
  return age<newMemberDays*86400000;
}

// Google Translate free API helper
const LANG_MAP={es:'es',ja:'ja',zh:'zh-CN',bn:'bn',fr:'fr',ar:'ar',ru:'ru'};
async function translateText(text:string,targetLang:string):Promise<string>{
  if(!text||!targetLang)return text;
  const tl=LANG_MAP[targetLang]||targetLang;
  // Try multiple translation APIs
  for(const api of [
    ()=>fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`).then(r=>r.json()).then(d=>d[0].map((s:any[])=>s[0]).join('')),
    ()=>fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${tl}`).then(r=>r.json()).then(d=>d.responseData?.translatedText||text),
  ]){
    try{const result=await api();if(result&&result!==text)return result;}catch{}
  }
  return text;
}
async function translateBlogPost(DB:any,postId:string,title:string,excerpt:string,content:string){
  const langs=['es','ja','zh','bn','fr','ar','ru'];
  for(const lang of langs){
    const id=crypto.randomUUID();
    const slugSuffix=lang;
    const [tTitle,tExcerpt,tContent]=await Promise.all([translateText(title,lang),translateText(excerpt,lang),translateText(content,lang)]);
    const slug_row=await DB.prepare('SELECT slug FROM blog_posts WHERE id=?').bind(postId).first();
    const baseSlug=slug_row?.slug||'post';
    try{
      await DB.prepare('INSERT INTO blog_posts(id,slug,title,excerpt,content,author_id,status,lang,parent_id,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?,datetime(\'now\'),datetime(\'now\'))').bind(id,`${baseSlug}-${slugSuffix}`,tTitle,tExcerpt,tContent,'system','published',lang,postId).run();
    }catch(e:any){
      console.error(`Translation insert failed for ${lang}:`,e.message);
    }
  }
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
    try{
    const url=new URL(req.url);const p=url.pathname;
    if(req.method==='OPTIONS')return new Response(null,{headers:cors});

    // Migration: founding_member_override column
    try{await env.DB.prepare("ALTER TABLE users ADD COLUMN founding_member_override INTEGER DEFAULT 0").run();}catch{}
    // Migration: used_relay column to sessions
    try{await env.DB.prepare("ALTER TABLE sessions ADD COLUMN used_relay INTEGER DEFAULT 0").run();}catch{}
    // Migration: streak tracking columns
    try{await env.DB.prepare("ALTER TABLE users ADD COLUMN streak_count INTEGER DEFAULT 0").run();}catch{}
    try{await env.DB.prepare("ALTER TABLE users ADD COLUMN last_call_date TEXT").run();}catch{}
    // Migration: ensure admin emails have is_admin=1
    try{for(const email of ADMIN_EMAILS){await env.DB.prepare("UPDATE users SET is_admin=1 WHERE email=? AND is_admin=0").bind(email).run();}}catch{}
    // Migration: auto-grant FM badge to first 100 users
    try{await env.DB.prepare("UPDATE users SET founding_member_override=1 WHERE id IN (SELECT id FROM users ORDER BY created_at ASC LIMIT 100) AND founding_member_override=0").run();}catch{}
    // Migration: usage tracking table
    try{await env.DB.prepare("CREATE TABLE IF NOT EXISTS daily_usage(day TEXT PRIMARY KEY,api_requests INTEGER DEFAULT 0,d1_reads INTEGER DEFAULT 0,d1_writes INTEGER DEFAULT 0,do_requests INTEGER DEFAULT 0,created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();}catch{}
    // Migration: feedback table
    try{await env.DB.prepare("CREATE TABLE IF NOT EXISTS feedback(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,category TEXT NOT NULL,message TEXT NOT NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();}catch{}
    // Migration: password reset tokens
    try{await env.DB.prepare("CREATE TABLE IF NOT EXISTS password_resets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,token TEXT NOT NULL,expires_at DATETIME NOT NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();}catch{}
    // Migration: blog posts table
    try{await env.DB.prepare("CREATE TABLE IF NOT EXISTS blog_posts(id TEXT PRIMARY KEY,slug TEXT UNIQUE NOT NULL,title TEXT NOT NULL,excerpt TEXT,content TEXT NOT NULL,author_id TEXT,status TEXT DEFAULT 'draft',lang TEXT DEFAULT 'en',created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)").run();}catch{}
    // Migration: blog_posts parent_id for translations
    try{await env.DB.prepare("ALTER TABLE blog_posts ADD COLUMN parent_id TEXT").run();}catch{}
    // Track API request (fire-and-forget)
    try{const day=todayUTC();await env.DB.prepare("INSERT INTO daily_usage(day,api_requests,d1_reads,d1_writes)VALUES(?,1,1,0)ON CONFLICT(day)DO UPDATE SET api_requests=api_requests+1,d1_reads=d1_reads+1").bind(day).run();}catch{}

    // ICE servers: Google STUN (free) + metered.ca TURN (relay only)
    if(p==='/api/ice-servers'){
      try{
        const r=await fetch(`https://chatter3.metered.live/api/v1/turn/credentials?apiKey=${env.METERED_API_KEY}`);
        const mt=await r.json();
        // Add Google STUN first (free, faster discovery), keep metered TURN for relay
        const iceServers=[{urls:'stun:stun.l.google.com:19302'},...(mt.iceServers||[])];
        return json({iceServers});
      }catch{
        return json({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
      }
    }

    // Public status endpoint (maintenance mode check)
    if(p==='/api/status'){
      const cfg=await getSettings(env.DB);
      return json({maintenance:cfg.maintenanceMode,maintenanceMessage:cfg.maintenanceMessage,settings:{matching_by_level:cfg.matchByLevel?'true':'false'}});
    }

    // Online stats with by_level
    if(p==='/api/stats/online'){
      const[q,s,bl,a]:any[]=await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as c FROM matching_queue').first(),
        env.DB.prepare("SELECT COUNT(*) as c FROM sessions WHERE status='active'").first(),
        env.DB.prepare('SELECT english_level,COUNT(*) as c FROM matching_queue GROUP BY english_level').all(),
        env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE last_active >= datetime('now','-2 minutes')").first(),
      ]);
      const by_level:Record<string,number>={};
      for(const r of (bl.results||[]))by_level[(r as any).english_level]=(r as any).c;
      const total = (q?.c||0) + ((s?.c||0)*2) + (a?.c||0);
      return json({searching:q?.c||0,in_call:(s?.c||0)*2,total,by_level});
    }

    // ── AUTH ───────────────────────────────────────────────────
    if(p==='/api/auth/google'&&req.method==='POST'){
      const{credential,ref}=await req.json() as any;
      try{
        const pts=credential.split('.');
        if(pts.length!==3)return json({success:false,error:'Invalid token format'});
        const header=JSON.parse(new TextDecoder().decode(base64urlDecode(pts[0])));
        const payload=JSON.parse(new TextDecoder().decode(base64urlDecode(pts[1])));
        // Verify Google JWT claims (aud, iss, exp, email_verified)
        if(header.alg!=='RS256')return json({success:false,error:'Unexpected algorithm'});
        if(!payload.aud||payload.aud!==env.GOOGLE_CLIENT_ID)return json({success:false,error:'Invalid audience'});
        if(payload.iss!=='accounts.google.com'&&payload.iss!=='https://accounts.google.com')return json({success:false,error:'Invalid issuer'});
        if(payload.exp&&payload.exp*1000<Date.now())return json({success:false,error:'Token expired'});
        if(!payload.email||payload.email_verified===false)return json({success:false,error:'Email not verified'});
        // Best-effort signature verification against Google's public keys
        try{
          const googleKeys=await fetch('https://www.googleapis.com/oauth2/v3/certs').then(r=>r.json()) as any;
          let sigVerified=false;
          for(const k of (googleKeys.keys||[])){
            if(k.kid===header.kid){
              try{
                const pubKey=await crypto.subtle.importKey('jwk',k,{name:'RSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
                sigVerified=await crypto.subtle.verify('RSA-PKCS1-v1_5',pubKey,base64urlDecode(pts[2]),new TextEncoder().encode(`${pts[0]}.${pts[1]}`));
              }catch{}
              break;
            }
          }
          if(!sigVerified)console.error('Google JWT signature verification failed for kid='+header.kid);
        }catch(e:any){console.error('Google key fetch failed:',e?.message);}
        const email=payload.email;
        const name=payload.name||email.split('@')[0];
        const pic=payload.picture||'';
        const isAdmin=ADMIN_EMAILS.includes(email)?1:0;
        const cfg=await getSettings(env.DB);
        const initRp=cfg.promoInitialRp||0;
        let user:any=await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
        let isNewUser=false;
        if(!user){
          isNewUser=true;
          const id=uuid();
          await env.DB.prepare(`INSERT INTO users(id,username,email,password_hash,english_level,points,fp_balance,fp_last_reset,rp_balance,is_admin,created_at,avatar_url,nickname)VALUES(?,?,?,'google_oauth_user','beginner',0,?,?,0,?,datetime('now'),?,?)`).bind(id,name,email,DAILY_FP,todayUTC(),isAdmin,pic,name).run();
          const uc=await env.DB.prepare('SELECT COUNT(*) as c FROM users').first();
          if((uc?.c??0)<=100)await env.DB.prepare('UPDATE users SET founding_member_override=1 WHERE id=?').bind(id).run().catch(()=>{});
          if(initRp>0){
            await env.DB.prepare('UPDATE users SET rp_balance=? WHERE id=?').bind(initRp,id).run();
            await env.DB.prepare("INSERT INTO point_transactions(id,user_id,points,activity_type,created_at)VALUES(?,?,?,'promo_registration_bonus',datetime('now'))").bind(uuid(),id,initRp).run().catch(()=>{});
          }
          user=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
          if(ref){
            await env.DB.prepare("UPDATE invites SET used=1,invitee_id=? WHERE inviter_id=? AND used=0").bind(id,ref).run().catch(()=>{});
            await env.DB.prepare('UPDATE users SET rp_balance=rp_balance+5 WHERE id=?').bind(id).run().catch(()=>{});
            await env.DB.prepare("INSERT INTO point_transactions(id,user_id,points,activity_type,created_at)VALUES(?,?,5,'referral_bonus',datetime('now'))").bind(uuid(),id).run().catch(()=>{});
            await env.DB.prepare('UPDATE users SET rp_balance=rp_balance+5 WHERE id=?').bind(ref).run().catch(()=>{});
            await env.DB.prepare("INSERT INTO point_transactions(id,user_id,points,activity_type,created_at)VALUES(?,?,5,'referral_bonus',datetime('now'))").bind(uuid(),ref).run().catch(()=>{});
          }
        }else{
          if(isAdmin)await env.DB.prepare('UPDATE users SET is_admin=1 WHERE id=?').bind(user.id).run();
          await ensureDailyFP(env.DB,user.id);
          user=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
        }
        user.founding_member=isFoundingMember(user.founding_member_override);
        user.in_free_period=inFpFreePeriod(user.created_at,cfg.promoFpFreeDays);user.is_new_member=isNewMember(user.created_at,cfg.newMemberDays);
        user.has_password=!isLegacyPassword(user.password_hash);
        const token=await createSessionToken(env,user.id,!!user.is_admin);
        const sanitized=sanitizeUser(user);
        if(isNewUser){
          const html=`<h2>New User Registration</h2><p><b>Username:</b> ${esc(name)}</p><p><b>Email:</b> ${esc(email)}</p><p><b>Method:</b> Google OAuth</p><p><b>RP Bonus:</b> ${initRp}</p><hr/><p><a href="${APP_URL}/admin">Admin Dashboard</a></p>`;
          await sendEmail(env.RESEND_API_KEY,'dax@chatter3.com','[Chatter3] New User Registration',html);
          await sendEmail(env.RESEND_API_KEY,'john@chatter3.com','[Chatter3] New User Registration',html);
          const welcomeHtml=`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px"><h2 style="color:#4f46e5">Welcome to Chatter3!</h2><p>Hi <b>${esc(name)}</b>,</p><p>Your account is set up and ready to go. Here's how to get started:</p><ul><li><b>Free Practice (FP)</b> — You get <b>${DAILY_FP} FP</b> daily for 1-on-1 video calls</li><li><b>Reward Points (RP)</b> — Earn RP for completing calls and practicing with partners</li><li><b>Find a Partner</b> — Head to the dashboard and hit "Find Partner" to start</li></ul><p>Practice a little every day and you'll see real improvement fast.</p><p style="margin-top:24px"><a href="${APP_URL}" style="background:#4f46e5;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold">Start Practicing</a></p><p style="color:#9ca3af;font-size:12px;margin-top:30px">If you didn't create this account, you can safely ignore this email.</p></div>`;
          await sendEmail(env.RESEND_API_KEY,email,'Welcome to Chatter3!',welcomeHtml);
        }
        return json({success:true,user:sanitized,token});
      }catch(e:any){return json({success:false,error:'Invalid token',detail:e?.message||String(e)});}
    }

    if(p==='/api/auth/register'&&req.method==='POST'){
      const{email,username,password,english_level,country,native_language,ref,turnstileToken}=await req.json() as any;
      if(!email||!username||!password)return json({success:false,error:'Email, username, and password are required'});
      if(password.length<6)return json({success:false,error:'Password must be at least 6 characters'});
      const ip=req.headers.get('CF-Connecting-IP')||'';
      if(!await verifyTurnstile(turnstileToken,env.TURNSTILE_SECRET_KEY,ip))return json({success:false,error:'Robot verification failed. Please try again.'});
      const id=uuid();
      const cfg=await getSettings(env.DB);
      const initRp=cfg.promoInitialRp||0;
      const passwordHash=await hashPassword(password);
      try{
        await env.DB.prepare(`INSERT INTO users(id,username,email,password_hash,english_level,points,fp_balance,fp_last_reset,rp_balance,country,native_language,created_at)VALUES(?,?,?,?,?,0,?,?,0,?,?,datetime('now'))`).bind(id,username,email,passwordHash,english_level||'beginner',DAILY_FP,todayUTC(),country||'',native_language||'').run();
        const uc=await env.DB.prepare('SELECT COUNT(*) as c FROM users').first();
        if((uc?.c??0)<=100)await env.DB.prepare('UPDATE users SET founding_member_override=1 WHERE id=?').bind(id).run().catch(()=>{});
        if(initRp>0){
          await env.DB.prepare('UPDATE users SET rp_balance=? WHERE id=?').bind(initRp,id).run();
          await env.DB.prepare("INSERT INTO point_transactions(id,user_id,points,activity_type,created_at)VALUES(?,?,?,'promo_registration_bonus',datetime('now'))").bind(uuid(),id,initRp).run().catch(()=>{});
        }
        if(ref){
          await env.DB.prepare("UPDATE invites SET used=1,invitee_id=? WHERE inviter_id=? AND used=0").bind(id,ref).run().catch(()=>{});
          await env.DB.prepare('UPDATE users SET rp_balance=rp_balance+5 WHERE id=?').bind(id).run().catch(()=>{});
          await env.DB.prepare("INSERT INTO point_transactions(id,user_id,points,activity_type,created_at)VALUES(?,?,5,'referral_bonus',datetime('now'))").bind(uuid(),id).run().catch(()=>{});
          await env.DB.prepare('UPDATE users SET rp_balance=rp_balance+5 WHERE id=?').bind(ref).run().catch(()=>{});
          await env.DB.prepare("INSERT INTO point_transactions(id,user_id,points,activity_type,created_at)VALUES(?,?,5,'referral_bonus',datetime('now'))").bind(uuid(),ref).run().catch(()=>{});
        }
        const user:any=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
        user.founding_member=isFoundingMember(user.founding_member_override);
        user.in_free_period=inFpFreePeriod(user.created_at,cfg.promoFpFreeDays);user.is_new_member=isNewMember(user.created_at,cfg.newMemberDays);
        user.has_password=!isLegacyPassword(user.password_hash);
        const token=await createSessionToken(env,user.id,false);
        const sanitized=sanitizeUser(user);
        const html=`<h2>New User Registration</h2><p><b>Username:</b> ${esc(username)}</p><p><b>Email:</b> ${esc(email)}</p><p><b>Method:</b> Email Signup</p><p><b>Level:</b> ${esc(english_level||'beginner')}</p><p><b>RP Bonus:</b> ${initRp}</p><hr/><p><a href="${APP_URL}/admin">Admin Dashboard</a></p>`;
        await sendEmail(env.RESEND_API_KEY,'dax@chatter3.com','[Chatter3] New User Registration',html);
        await sendEmail(env.RESEND_API_KEY,'john@chatter3.com','[Chatter3] New User Registration',html);
        const welcomeHtml=`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px"><h2 style="color:#4f46e5">Welcome to Chatter3! 🎉</h2><p>Hi <b>${esc(username)}</b>,</p><p>Your account is set up and ready to go. Here's how to get started:</p><ul><li><b>Free Practice (FP)</b> — You get <b>${DAILY_FP} FP</b> daily for 1-on-1 video calls</li><li><b>Reward Points (RP)</b> — Earn RP for completing calls and practicing with partners</li><li><b>Find a Partner</b> — Head to the dashboard and hit "Find Partner" to start</li></ul><p>Practice a little every day and you'll see real improvement fast.</p><p style="margin-top:24px"><a href="${APP_URL}" style="background:#4f46e5;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold">Start Practicing →</a></p><p style="color:#9ca3af;font-size:12px;margin-top:30px">If you didn't create this account, you can safely ignore this email.</p></div>`;
        await sendEmail(env.RESEND_API_KEY,email,'Welcome to Chatter3!',welcomeHtml);
        return json({success:true,user:sanitized,token});
      }catch{return json({success:false,error:'User already exists'});}
    }

    if(p==='/api/auth/login'&&req.method==='POST'){
      const{email,password,turnstileToken}=await req.json() as any;
      if(!email)return json({success:false,error:'Email is required'});
      const ip=req.headers.get('CF-Connecting-IP')||'';
      if(!await verifyTurnstile(turnstileToken,env.TURNSTILE_SECRET_KEY,ip))return json({success:false,error:'Robot verification failed. Please try again.'});
      const user:any=await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
      if(!user)return json({success:false,error:'Invalid email or password'});
      if(user.is_banned)return json({success:false,error:'Account suspended. Contact support.'});
      if(!isLegacyPassword(user.password_hash)){
        if(!password)return json({success:false,error:'Password is required'});
        if(!await verifyPassword(password,user.password_hash))return json({success:false,error:'Invalid email or password'});
      }
      await ensureDailyFP(env.DB,user.id);
      const u:any=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
      const cfg=await getSettings(env.DB);
      u.founding_member=isFoundingMember(u.founding_member_override);
      u.in_free_period=inFpFreePeriod(u.created_at,cfg.promoFpFreeDays);u.is_new_member=isNewMember(u.created_at,cfg.newMemberDays);
      u.has_password=!isLegacyPassword(u.password_hash);
      const token=await createSessionToken(env,u.id,!!u.is_admin);
      const sanitized=sanitizeUser(u);
      return json({success:true,user:sanitized,token});
    }

    // ── CHANGE PASSWORD ──────────────────────────────────────
    if(p==='/api/auth/change-password'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{current_password,new_password}=await req.json() as any;
      if(!new_password)return json({success:false,error:'New password is required'});
      if(new_password.length<6)return json({success:false,error:'New password must be at least 6 characters'});
      const user:any=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(auth.userId).first();
      if(!user)return json({success:false,error:'User not found'});
      if(!isLegacyPassword(user.password_hash)){
        if(!current_password)return json({success:false,error:'Current password is required'});
        if(!await verifyPassword(current_password,user.password_hash))return json({success:false,error:'Current password is incorrect'});
      }
      const newHash=await hashPassword(new_password);
      await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(newHash,auth.userId).run();
      return json({success:true,message:'Password updated'});
    }

    // ── FORGOT PASSWORD ─────────────────────────────────────
    if(p==='/api/auth/forgot-password'&&req.method==='POST'){
      const{email}=await req.json() as any;
      if(!email)return json({success:false,error:'Email is required'});
      const user:any=await env.DB.prepare('SELECT id,email FROM users WHERE email=?').bind(email).first();
      // Always return success to prevent email enumeration
      if(!user||isLegacyPassword((await env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(user.id).first())?.password_hash)){
        return json({success:true,message:'If an account exists with that email, a reset link has been sent.'});
      }
      const token=uuid();
      const expiresAt=new Date(Date.now()+3600000).toISOString().replace('T',' ').slice(0,19);
      await env.DB.prepare('DELETE FROM password_resets WHERE user_id=?').bind(user.id).run();
      await env.DB.prepare('INSERT INTO password_resets(id,user_id,token,expires_at)VALUES(?,?,?,?)').bind(uuid(),user.id,token,expiresAt).run();
      const resetUrl=`${APP_URL}/reset-password?token=${token}`;
      const html=`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px"><h2 style="color:#4f46e5">Password Reset Request</h2><p>Hi,</p><p>We received a request to reset your password for your Chatter3 account.</p><p style="margin:24px 0"><a href="${resetUrl}" style="background:#4f46e5;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">Reset Password</a></p><p style="color:#9ca3af;font-size:12px">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p></div>`;
      await sendEmail(env.RESEND_API_KEY,user.email,'Reset Your Chatter3 Password',html);
      return json({success:true,message:'If an account exists with that email, a reset link has been sent.'});
    }

    // ── RESET PASSWORD ──────────────────────────────────────
    if(p==='/api/auth/reset-password'&&req.method==='POST'){
      const{token,new_password}=await req.json() as any;
      if(!token||!new_password)return json({success:false,error:'Token and new password are required'});
      if(new_password.length<6)return json({success:false,error:'Password must be at least 6 characters'});
      const reset:any=await env.DB.prepare('SELECT * FROM password_resets WHERE token=?').bind(token).first();
      if(!reset)return json({success:false,error:'Invalid or expired reset token'});
      if(new Date(reset.expires_at)<new Date())return json({success:false,error:'Reset token has expired'});
      const newHash=await hashPassword(new_password);
      await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(newHash,reset.user_id).run();
      await env.DB.prepare('DELETE FROM password_resets WHERE id=?').bind(reset.id).run();
      return json({success:true,message:'Password updated successfully'});
    }

    // ── USER ───────────────────────────────────────────────────
    if(p.startsWith('/api/user/balances/')){
      const uid=p.split('/').pop();
      await ensureDailyFP(env.DB,uid as string);
      await env.DB.prepare("UPDATE users SET last_active=datetime('now') WHERE id=?").bind(uid).run().catch(()=>{});
      const u:any=await env.DB.prepare('SELECT fp_balance,rp_balance,created_at,founding_member_override FROM users WHERE id=?').bind(uid).first();
      const cfg=await getSettings(env.DB);
      return json({success:true,fp:u?.fp_balance??0,rp:u?.rp_balance??0,founding_member:isFoundingMember(u?.founding_member_override),in_free_period:inFpFreePeriod(u?.created_at,cfg.promoFpFreeDays),is_new_member:isNewMember(u?.created_at,cfg.newMemberDays)});
    }

    if(p==='/api/user/exchange-rp'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{quantity}=await req.json() as any;
      const qty=Math.max(1,parseInt(quantity)||1);
      const cost=qty*RP_TO_FP;
      await ensureDailyFP(env.DB,auth.userId);
      const u:any=await env.DB.prepare('SELECT fp_balance,rp_balance FROM users WHERE id=?').bind(auth.userId).first();
      if(!u)return json({success:false,error:'User not found'});
      if(u.rp_balance<cost)return json({success:false,error:`Need ${cost} RP (have ${u.rp_balance.toFixed(1)})`});
      await env.DB.prepare('UPDATE users SET rp_balance=rp_balance-?,fp_balance=fp_balance+? WHERE id=?').bind(cost,qty,auth.userId).run();
      const f:any=await env.DB.prepare('SELECT fp_balance,rp_balance FROM users WHERE id=?').bind(auth.userId).first();
      return json({success:true,fp:f.fp_balance,rp:f.rp_balance});
    }

    if(p==='/api/user/update'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{username,nickname,country,native_language,english_level,bio,avatar_url}=await req.json() as any;
      if(username){
        const dupe:any=await env.DB.prepare('SELECT id FROM users WHERE username=? AND id!=?').bind(username,auth.userId).first();
        if(!dupe)await env.DB.prepare('UPDATE users SET username=? WHERE id=?').bind(username,auth.userId).run();
      }
      await env.DB.prepare('UPDATE users SET nickname=?,country=?,native_language=?,english_level=?,bio=?,avatar_url=? WHERE id=?').bind(nickname||username,country,native_language,english_level,bio,avatar_url,auth.userId).run();
      const u:any=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(auth.userId).first();
      const cfg=await getSettings(env.DB);
      u.founding_member=isFoundingMember(u.founding_member_override);
      u.in_free_period=inFpFreePeriod(u.created_at,cfg.promoFpFreeDays);u.is_new_member=isNewMember(u.created_at,cfg.newMemberDays);
      u.has_password=!isLegacyPassword(u.password_hash);
      const sanitized=sanitizeUser(u);
      return json({success:true,user:sanitized});
    }

    if(p==='/api/user/history'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const h=await env.DB.prepare(`SELECT s.id,s.created_at,s.ended_at,s.duration,CASE WHEN s.user1_id=? THEN u2.username ELSE u1.username END as partner_name,CASE WHEN s.user1_id=? THEN u2.avatar_url ELSE u1.avatar_url END as partner_avatar,pt.points as points_earned FROM sessions s JOIN users u1 ON s.user1_id=u1.id JOIN users u2 ON s.user2_id=u2.id LEFT JOIN point_transactions pt ON pt.session_id=s.id AND pt.user_id=? AND pt.activity_type='video_call_reward' WHERE(s.user1_id=? OR s.user2_id=?)AND s.status='completed' ORDER BY s.created_at DESC LIMIT 20`).bind(auth.userId,auth.userId,auth.userId,auth.userId,auth.userId).all();
      return json({success:true,history:h.results});
    }

    if(p.startsWith('/api/user/')&&req.method==='GET'&&!p.includes('/balances')){
      const uid=p.split('/').pop();
      await env.DB.prepare("UPDATE users SET last_active=datetime('now') WHERE id=?").bind(uid).run().catch(()=>{});
      const u:any=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(uid).first();
      if(!u)return json({success:false,error:'User not found'});
      const cfg=await getSettings(env.DB);
      u.founding_member=isFoundingMember(u.founding_member_override);
      u.in_free_period=inFpFreePeriod(u.created_at,cfg.promoFpFreeDays);u.is_new_member=isNewMember(u.created_at,cfg.newMemberDays);
      u.has_password=!isLegacyPassword(u.password_hash);
      return json({success:true,user:sanitizeUser(u)});
    }

    // ── INVITE ─────────────────────────────────────────────────
    if(p==='/api/invite/create'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const id=uuid();
      await env.DB.prepare("INSERT INTO invites(id,inviter_id,created_at)VALUES(?,?,datetime('now'))").bind(id,auth.userId).run();
      return json({success:true,invite_url:`${APP_URL}/?ref=${auth.userId}`,invite_id:id});
    }

    if(p==='/api/invite/stats'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const total:any=await env.DB.prepare('SELECT COUNT(*) as c FROM invites WHERE inviter_id=?').bind(auth.userId).first();
      const used:any=await env.DB.prepare('SELECT COUNT(*) as c FROM invites WHERE inviter_id=? AND used=1').bind(auth.userId).first();
      return json({success:true,total:total?.c||0,used:used?.c||0});
    }

    // ── FRIENDS ────────────────────────────────────────────────
    if(p==='/api/friends/search'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{query}=await req.json() as any;
      const cfg=await getSettings(env.DB);
      const q=`%${query||''}%`;
      const users=await env.DB.prepare(`SELECT id,username,nickname,avatar_url,country,english_level,created_at,founding_member_override FROM users WHERE(username LIKE ? OR nickname LIKE ?)AND id!=? AND is_banned=0 LIMIT 20`).bind(q,q,auth.userId).all();
      for(const u of (users.results||[])){u.founding_member=isFoundingMember(u.founding_member_override);u.in_free_period=inFpFreePeriod(u.created_at,cfg.promoFpFreeDays);u.is_new_member=isNewMember(u.created_at,cfg.newMemberDays);}
      return json({success:true,users:users.results});
    }

    if(p==='/api/friends/request'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{receiver_id}=await req.json() as any;
      const sender_id=auth.userId;
      if(sender_id===receiver_id)return json({success:false,error:"Can't add yourself"});
      const id=uuid();
      try{
        await env.DB.prepare("INSERT INTO friend_requests(id,sender_id,receiver_id,status,created_at)VALUES(?,?,?,'pending',datetime('now'))").bind(id,sender_id,receiver_id).run();
        const[s,r]:any[]=await Promise.all([
          env.DB.prepare('SELECT username FROM users WHERE id=?').bind(sender_id).first(),
          env.DB.prepare('SELECT email,username FROM users WHERE id=?').bind(receiver_id).first(),
        ]);
        if(r?.email)await sendEmail(env.RESEND_API_KEY,r.email,'[Chatter3] New Friend Request',`<p>${esc(s?.username||'Someone')} sent you a friend request on Chatter3!</p><p><a href="${APP_URL}">Open Chatter3</a> to accept or decline.</p>`);
        return json({success:true});
      }catch{return json({success:false,error:'Request already sent or already friends'});}
    }

    if(p==='/api/friends/respond'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{request_id,action}=await req.json() as any;
      const fr:any=await env.DB.prepare('SELECT * FROM friend_requests WHERE id=? AND receiver_id=?').bind(request_id,auth.userId).first();
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
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const cfg=await getSettings(env.DB);
      const friends=await env.DB.prepare(`SELECT u.id,u.username,u.nickname,u.avatar_url,u.country,u.english_level,u.created_at,u.founding_member_override FROM friends f JOIN users u ON f.friend_id=u.id WHERE f.user_id=? ORDER BY u.username ASC`).bind(auth.userId).all();
      for(const u of (friends.results||[])){u.founding_member=isFoundingMember(u.founding_member_override);u.in_free_period=inFpFreePeriod(u.created_at,cfg.promoFpFreeDays);u.is_new_member=isNewMember(u.created_at,cfg.newMemberDays);}
      const pending=await env.DB.prepare(`SELECT fr.id,fr.sender_id,fr.created_at,u.username,u.nickname,u.avatar_url FROM friend_requests fr JOIN users u ON fr.sender_id=u.id WHERE fr.receiver_id=? AND fr.status='pending'`).bind(auth.userId).all();
      const sent=await env.DB.prepare(`SELECT fr.id,fr.receiver_id,fr.status,u.username FROM friend_requests fr JOIN users u ON fr.receiver_id=u.id WHERE fr.sender_id=?`).bind(auth.userId).all();
      return json({success:true,friends:friends.results,pending_requests:pending.results,sent_requests:sent.results});
    }

    if(p==='/api/friends/remove'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{friend_id}=await req.json() as any;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM friends WHERE user_id=? AND friend_id=?').bind(auth.userId,friend_id),
        env.DB.prepare('DELETE FROM friends WHERE user_id=? AND friend_id=?').bind(friend_id,auth.userId),
      ]);
      return json({success:true});
    }

    // ── MATCHING ───────────────────────────────────────────────
    if(p==='/api/matching/join'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{english_level,country,native_language}=await req.json() as any;
      const user_id=auth.userId;
      await ensureDailyFP(env.DB,user_id);
      // Check for existing active session first (partner may have already matched us)
      const existingSession:any=await env.DB.prepare("SELECT id FROM sessions WHERE (user1_id=? OR user2_id=?) AND status='active' LIMIT 1").bind(user_id,user_id).first();
      if(existingSession){
        const cfg=await getSettings(env.DB);
        return json({success:true,matched:true,session_id:existingSession.id,custom_duration:cfg.mvpMode?5:(cfg.customDuration||0)});
      }
      const cfg=await getSettings(env.DB);
      const caller:any=await env.DB.prepare('SELECT fp_balance,country,native_language,is_banned,created_at FROM users WHERE id=?').bind(user_id).first();
      if(!caller)return json({success:false,error:'User not found'});
      if(caller.is_banned)return json({success:false,error:'Account suspended'});
      const inFreePeriod=inFpFreePeriod(caller.created_at,cfg.promoFpFreeDays);
      if(!inFreePeriod&&(caller.fp_balance||0)<1)return json({success:false,error:'insufficient_fp',fp:caller.fp_balance});

      const cCountry=(caller.country||country||'').trim().toLowerCase();
      const cLang=(caller.native_language||native_language||'').trim().toLowerCase();

      try{await env.DB.prepare("DELETE FROM matching_queue WHERE joined_at < datetime('now','-15 seconds')").run();}catch{}

      // Build WHERE clauses based on settings
      let strictQ=`SELECT mq.user_id FROM matching_queue mq JOIN users u ON mq.user_id=u.id WHERE u.is_banned=0 AND mq.user_id!=?`;
      const strictB:any[]=[user_id];
      if(cfg.matchByLevel&&!cfg.mvpMode){strictQ+=` AND mq.english_level=?`;strictB.push(english_level);}
      if(cfg.matchDiffCountry&&cCountry){strictQ+=` AND (?='' OR LOWER(COALESCE(u.country,''))!=?)`;strictB.push(cCountry,cCountry);}
      if(cfg.matchDiffLang&&cLang){strictQ+=` AND (?='' OR LOWER(COALESCE(u.native_language,''))!=?)`;strictB.push(cLang,cLang);}
      strictQ+=` AND mq.user_id NOT IN(SELECT blocked_id FROM user_blocks WHERE blocker_id=? UNION SELECT blocker_id FROM user_blocks WHERE blocked_id=?) AND mq.user_id NOT IN(SELECT user1_id FROM sessions WHERE status='active' UNION SELECT user2_id FROM sessions WHERE status='active') ORDER BY mq.joined_at ASC LIMIT 1`;
      strictB.push(user_id,user_id);

      const match:any=await env.DB.prepare(strictQ).bind(...strictB).first();

      if(match){
        const sid=uuid();const pid=match.user_id as string;
        // Deduct FP only if neither user is in free period
        const partner:any=await env.DB.prepare('SELECT created_at FROM users WHERE id=?').bind(pid).first();
        const partnerFree=inFpFreePeriod(partner?.created_at,cfg.promoFpFreeDays);
        const batch:any[]=[
          env.DB.prepare("INSERT INTO sessions(id,user1_id,user2_id,english_level,status,created_at)VALUES(?,?,?,?,'active',datetime('now'))").bind(sid,user_id,pid,english_level),
          env.DB.prepare('DELETE FROM matching_queue WHERE user_id=?').bind(pid),
          env.DB.prepare('DELETE FROM matching_queue WHERE user_id=?').bind(user_id),
        ];
        if(!inFreePeriod)batch.unshift(env.DB.prepare("UPDATE users SET fp_balance=fp_balance-1 WHERE id=? AND fp_balance>=1").bind(user_id));
        if(!partnerFree)batch.unshift(env.DB.prepare("UPDATE users SET fp_balance=fp_balance-1 WHERE id=? AND fp_balance>=1").bind(pid));
        await env.DB.batch(batch);
        return json({success:true,matched:true,session_id:sid,custom_duration:cfg.mvpMode?5:(cfg.customDuration||0)});
      }
      await env.DB.prepare("INSERT OR REPLACE INTO matching_queue(user_id,english_level,joined_at)VALUES(?,?,datetime('now'))").bind(user_id,english_level).run();
      return json({success:true,matched:false});
    }

    if(p==='/api/matching/leave'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const user_id=auth.userId;
      await env.DB.prepare('DELETE FROM matching_queue WHERE user_id=?').bind(user_id).run();
      // Race condition: a match may have been created between the last poll and cancel.
      // If an active session exists where the user never connected, end it and refund both users.
      const sess:any=await env.DB.prepare("SELECT * FROM sessions WHERE(user1_id=? OR user2_id=?)AND status='active' AND connected_at IS NULL ORDER BY created_at DESC LIMIT 1").bind(user_id,user_id).first();
      if(sess){
        const dur=Math.floor((Date.now()-new Date(sess.created_at).getTime())/1000);
        const cfg=await getSettings(env.DB);
        const u1:any=await env.DB.prepare('SELECT created_at FROM users WHERE id=?').bind(sess.user1_id).first();
        const u2:any=await env.DB.prepare('SELECT created_at FROM users WHERE id=?').bind(sess.user2_id).first();
        const u1Free=inFpFreePeriod(u1?.created_at,cfg.promoFpFreeDays);
        const u2Free=inFpFreePeriod(u2?.created_at,cfg.promoFpFreeDays);
        const batch:any[]=[
          env.DB.prepare("UPDATE sessions SET status='completed',ended_at=datetime('now'),duration=?,disconnect_reason='early_leave' WHERE id=?").bind(dur,sess.id),
        ];
        if(!u1Free)batch.push(env.DB.prepare('UPDATE users SET fp_balance=fp_balance+1 WHERE id=?').bind(sess.user1_id));
        if(!u2Free)batch.push(env.DB.prepare('UPDATE users SET fp_balance=fp_balance+1 WHERE id=?').bind(sess.user2_id));
        await env.DB.batch(batch);
      }
      return json({success:true});
    }

    if(p.startsWith('/api/matching/session/')){
      const uid=p.split('/').pop();
      const sess:any=await env.DB.prepare("SELECT * FROM sessions WHERE(user1_id=? OR user2_id=?)AND status='active' LIMIT 1").bind(uid,uid).first();
      if(!sess)return json({active_session:false});
      const pid=sess.user1_id===uid?sess.user2_id:sess.user1_id;
      const partner:any=await env.DB.prepare('SELECT id,username,nickname,english_level,avatar_url,country,native_language,created_at,founding_member_override FROM users WHERE id=?').bind(pid).first();
      const cfg=await getSettings(env.DB);
      if(partner){partner.founding_member=isFoundingMember(partner.founding_member_override);partner.in_free_period=inFpFreePeriod(partner.created_at,cfg.promoFpFreeDays);partner.is_new_member=isNewMember(partner.created_at,cfg.newMemberDays);}
      return json({active_session:true,session:{...sess,partner,custom_duration:cfg.mvpMode?5:(cfg.customDuration||0)}});
    }

    if(p==='/api/matching/end'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{session_id,reason,used_relay}=await req.json() as any;
      const sess:any=await env.DB.prepare('SELECT * FROM sessions WHERE id=?').bind(session_id).first();
      if(sess&&sess.status==='active'){
        const dur=Math.floor((Date.now()-new Date(sess.created_at).getTime())/1000);
        await env.DB.prepare("UPDATE sessions SET status='completed',ended_at=datetime('now'),duration=?,disconnect_reason=?,used_relay=COALESCE(used_relay,?) WHERE id=?").bind(dur,reason||'hangup',used_relay?1:0,session_id).run();
      }
      return json({success:true});
    }

    if(p==='/api/matching/rate'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{session_id,rating,used_relay}=await req.json() as any;
      const user_id=auth.userId;
      const sess:any=await env.DB.prepare('SELECT * FROM sessions WHERE id=?').bind(session_id).first();
      if(!sess)return json({success:false,error:'Session not found'});
      const isU1=sess.user1_id===user_id;
      const field=isU1?'user1_rating':'user2_rating';
      const dur=Math.floor((Date.now()-new Date(sess.created_at).getTime())/1000);
      await env.DB.prepare(`UPDATE sessions SET ${field}=?,status='completed',duration=COALESCE(duration,?),used_relay=COALESCE(used_relay,?) WHERE id=?`).bind(rating,dur,used_relay?1:0,session_id).run();
      const updated:any=await env.DB.prepare('SELECT * FROM sessions WHERE id=?').bind(session_id).first();
      if(updated.user1_rating&&updated.user2_rating){
        const now=new Date().toISOString().replace('T',' ').slice(0,19);
        const u1=updated.user1_id,u2=updated.user2_id;
        const u1rp=RP_PER_COMPLETION+(updated.user2_rating==='good'?RP_PER_GOOD:0);
        const u2rp=RP_PER_COMPLETION+(updated.user1_rating==='good'?RP_PER_GOOD:0);
        // Update streaks for both users
        const today=todayUTC();
        const[u1Data,u2Data]:any[]=await Promise.all([
          env.DB.prepare('SELECT streak_count,last_call_date FROM users WHERE id=?').bind(u1).first(),
          env.DB.prepare('SELECT streak_count,last_call_date FROM users WHERE id=?').bind(u2).first(),
        ]);
        // Helper to calculate new streak
        const calcStreak=(lastDate:any,curCount:any)=>{
          if(!lastDate)return 1;
          const last=new Date(lastDate+'T00:00:00Z');
          const now2=new Date(today+'T00:00:00Z');
          const diffDays=Math.floor((now2.getTime()-last.getTime())/86400000);
          if(diffDays===0)return curCount||1;
          if(diffDays===1)return(curCount||0)+1;
          return 1;
        };
        const u1Streak=calcStreak(u1Data?.last_call_date,u1Data?.streak_count);
        const u2Streak=calcStreak(u2Data?.last_call_date,u2Data?.streak_count);
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET rp_balance=rp_balance+? WHERE id=?').bind(u1rp,u1),
          env.DB.prepare('UPDATE users SET rp_balance=rp_balance+? WHERE id=?').bind(u2rp,u2),
          env.DB.prepare("INSERT INTO point_transactions(id,user_id,points,activity_type,session_id,created_at)VALUES(?,?,?,'video_call_reward',?,?)").bind(uuid(),u1,u1rp,session_id,now),
          env.DB.prepare("INSERT INTO point_transactions(id,user_id,points,activity_type,session_id,created_at)VALUES(?,?,?,'video_call_reward',?,?)").bind(uuid(),u2,u2rp,session_id,now),
          env.DB.prepare('UPDATE users SET streak_count=?,last_call_date=? WHERE id=?').bind(u1Streak,today,u1),
          env.DB.prepare('UPDATE users SET streak_count=?,last_call_date=? WHERE id=?').bind(u2Streak,today,u2),
        ]);
        return json({success:true,rp_awarded:isU1?u1rp:u2rp,streak:isU1?u1Streak:u2Streak});
      }
      return json({success:true,message:'Rating saved. Waiting for partner.'});
    }

    // ── REPORT / BLOCK ─────────────────────────────────────────
    if(p==='/api/report'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{reported_id,session_id,reason}=await req.json() as any;
      const reporter_id=auth.userId;
      if(!reported_id)return json({success:false,error:'Missing fields'});
      const id=uuid();
      const now=new Date().toISOString().replace('T',' ').slice(0,19);
      await env.DB.prepare("INSERT INTO user_reports(id,reporter_id,reported_id,session_id,reason,created_at)VALUES(?,?,?,?,?,?)").bind(id,reporter_id,reported_id,session_id||null,reason||'',now).run();
      const[rep,rpd]:any[]=await Promise.all([
        env.DB.prepare('SELECT username,email FROM users WHERE id=?').bind(reporter_id).first(),
        env.DB.prepare('SELECT username,email FROM users WHERE id=?').bind(reported_id).first(),
      ]);
      await sendEmail(env.RESEND_API_KEY,REPORT_EMAIL,`[Chatter3] Report — ${reason}`,`<h2>New Report</h2><p><b>Reporter:</b> ${esc(rep?.username||'')} (${esc(rep?.email||'')})</p><p><b>Reported:</b> ${esc(rpd?.username||'')} (${esc(rpd?.email||'')})</p><p><b>Reason:</b> ${esc(reason||'')}</p><p><b>Session:</b> ${session_id||'N/A'}</p><p><b>Time:</b> ${now} UTC</p><hr/><p><a href="${APP_URL}/admin">Admin Dashboard</a></p>`);
      return json({success:true});
    }

    if(p==='/api/block'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{blocked_id}=await req.json() as any;
      const blocker_id=auth.userId;
      if(!blocked_id)return json({success:false,error:'Missing fields'});
      await env.DB.prepare("INSERT OR IGNORE INTO user_blocks(id,blocker_id,blocked_id,created_at)VALUES(?,?,?,datetime('now'))").bind(uuid(),blocker_id,blocked_id).run();
      return json({success:true});
    }

    // ── ADMIN ──────────────────────────────────────────────────
    if(p==='/api/admin/check'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      return json({is_admin:auth.isAdmin});
    }

    // User feedback submission
    if(p==='/api/feedback'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{category,message}=await req.json() as any;
      if(!category||!message)return json({error:'Missing fields'},400);
      const user:any=await env.DB.prepare('SELECT id,username,email FROM users WHERE id=?').bind(auth.userId).first();
      if(!user)return json({error:'User not found'},404);
      const id=uuid();
      const now=new Date().toISOString().replace('T',' ').slice(0,19);
      await env.DB.prepare("INSERT INTO feedback(id,user_id,category,message,created_at)VALUES(?,?,?,?,?)").bind(id,auth.userId,category,message,now).run();
      const today=todayUTC();
      const todayRewards:any=await env.DB.prepare("SELECT COUNT(*) as c FROM point_transactions WHERE user_id=? AND activity_type='feedback_reward' AND DATE(created_at)=?").bind(auth.userId,today).first();
      let rpAwarded=0;
      if((todayRewards?.c||0)<1){
        rpAwarded=0.5;
        await env.DB.prepare("UPDATE users SET rp_balance=rp_balance+0.5 WHERE id=?").bind(auth.userId).run();
        await env.DB.prepare("INSERT INTO point_transactions(id,user_id,points,activity_type,session_id,created_at)VALUES(?,?,0.5,'feedback_reward',NULL,?)").bind(uuid(),auth.userId,now).run();
      }
      const subject=`[Chatter3] Feedback — ${category}`;
      const html=`<h2>New User Feedback</h2><p><b>From:</b> ${esc(user.username)} (${esc(user.email)})</p><p><b>Category:</b> ${esc(category)}</p><p><b>Message:</b></p><p>${esc(message).replace(/\n/g,'<br/>')}</p><hr/><p><a href="${APP_URL}/admin">Admin Dashboard</a></p>`;
      await sendEmail(env.RESEND_API_KEY,'dax@chatter3.com',subject,html);
      await sendEmail(env.RESEND_API_KEY,'john@chatter3.com',subject,html);
      return json({success:true,rp_awarded:rpAwarded});
    }

    // Admin: read settings
    if(p==='/api/admin/settings'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const rows=await env.DB.prepare('SELECT key,value,updated_by,updated_at FROM app_settings').all();
      return json({success:true,settings:rows.results});
    }

    // Admin: update a setting
    if(p==='/api/admin/settings/update'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const{key,value}=await req.json() as any;
      const allowed=['matching_by_level','matching_diff_country','matching_diff_language','custom_call_duration','promo_fp_free_days','promo_initial_rp','promo_badge_days','new_member_days','mvp_mode','maintenance_mode','maintenance_message'];
      if(!allowed.includes(key))return json({error:'Unknown setting'},400);
      await env.DB.prepare("INSERT INTO app_settings(key,value,updated_by,updated_at)VALUES(?,?,?,datetime('now'))ON CONFLICT(key)DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(key,value,auth.userId).run();
      return json({success:true});
    }

    // Admin: stats
if(p==='/api/admin/stats'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const today=todayUTC(),monthStart=today.slice(0,7)+'-01';
      
      const safe=async(q)=>q.first().catch(()=>({}));
      const safeAll=async(q)=>q.all().catch(()=>({results:[]}));
      
      const[tu,dau,mau,ts,as2,qs,pr,nt]=await Promise.all([
        safe(env.DB.prepare('SELECT COUNT(*) as c FROM users')),
        safe(env.DB.prepare('SELECT COUNT(DISTINCT user_id) as c FROM point_transactions WHERE created_at>=?').bind(today)),
        safe(env.DB.prepare('SELECT COUNT(DISTINCT user_id) as c FROM point_transactions WHERE created_at>=?').bind(monthStart)),
        safe(env.DB.prepare("SELECT COUNT(*) as c FROM sessions WHERE status='completed'")),
        safe(env.DB.prepare("SELECT COUNT(*) as c FROM sessions WHERE status='active'")),
        safe(env.DB.prepare('SELECT COUNT(*) as c FROM matching_queue')),
        safe(env.DB.prepare("SELECT COUNT(*) as c FROM user_reports WHERE status='pending'")),
        safe(env.DB.prepare('SELECT COUNT(*) as c FROM users WHERE created_at>=?').bind(today)),
      ]);
      
      const[connStats,sessionStats,queueStats,crossBorderStats,browserStats,rematchStats,queueDepthStats,fpRpStats,retentionStats,reportStats]=await Promise.all([
        safe(env.DB.prepare(`SELECT 
          COUNT(*) as total_sessions,
          SUM(CASE WHEN connected_at IS NOT NULL THEN 1 ELSE 0 END) as connected,
          AVG(CASE WHEN connected_at IS NOT NULL AND created_at IS NOT NULL THEN 
            (julianday(connected_at) - julianday(created_at)) * 86400 END) as avg_time_to_connect,
          SUM(CASE WHEN disconnect_reason IN ('hangup','partner') THEN 1 ELSE 0 END) as intentional_ends,
          SUM(CASE WHEN disconnect_reason='network' THEN 1 ELSE 0 END) as network_disconnects,
          SUM(CASE WHEN disconnect_reason='connection_issue' THEN 1 ELSE 0 END) as connection_issues,
          SUM(CASE WHEN disconnect_reason='timeout' THEN 1 ELSE 0 END) as timeouts
        FROM sessions WHERE created_at>=DATE('now','-30 days')`)),
        safe(env.DB.prepare(`SELECT 
          COUNT(*) as completed_sessions,
          AVG(duration) as avg_duration,
          MAX(duration) as max_duration,
          SUM(CASE WHEN duration IS NOT NULL AND custom_duration IS NOT NULL AND duration >= custom_duration THEN 1 ELSE 0 END) as completed_full,
          SUM(CASE WHEN duration IS NOT NULL AND custom_duration IS NULL AND english_level='beginner' AND duration >= 270 THEN 1 ELSE 0 END) as completed_full_beginner,
          SUM(CASE WHEN duration IS NOT NULL AND custom_duration IS NULL AND english_level!='beginner' AND duration >= 540 THEN 1 ELSE 0 END) as completed_full_other,
          SUM(CASE WHEN user1_rating='good' OR user2_rating='good' THEN 1 ELSE 0 END) as good_ratings,
          SUM(CASE WHEN user1_rating='meh' OR user2_rating='meh' THEN 1 ELSE 0 END) as meh_ratings,
          SUM(CASE WHEN user1_rating='connection_issue' OR user2_rating='connection_issue' THEN 1 ELSE 0 END) as connection_issue_ratings
        FROM sessions WHERE status='completed' AND created_at>=DATE('now','-30 days')`)),
        safe(env.DB.prepare(`SELECT 
          AVG(CASE WHEN matched_at IS NOT NULL AND joined_at IS NOT NULL THEN 
            (julianday(matched_at) - julianday(joined_at)) * 86400 END) as avg_wait,
          MIN(CASE WHEN matched_at IS NOT NULL AND joined_at IS NOT NULL THEN 
            (julianday(matched_at) - julianday(joined_at)) * 86400 END) as min_wait,
          MAX(CASE WHEN matched_at IS NOT NULL AND joined_at IS NOT NULL THEN 
            (julianday(matched_at) - julianday(joined_at)) * 86400 END) as max_wait
        FROM matching_queue WHERE matched_at IS NOT NULL AND created_at>=DATE('now','-30 days')`)),
        safe(env.DB.prepare(`SELECT 
          COUNT(*) as total_matches,
          SUM(CASE WHEN u1.country != u2.country THEN 1 ELSE 0 END) as cross_border
        FROM sessions s
        JOIN users u1 ON s.user1_id = u1.id
        JOIN users u2 ON s.user2_id = u2.id
        WHERE s.created_at>=DATE('now','-30 days')`)),
        safeAll(env.DB.prepare(`SELECT 
          CASE 
            WHEN user_agent LIKE '%Chrome%' THEN 'Chrome'
            WHEN user_agent LIKE '%Firefox%' THEN 'Firefox'
            WHEN user_agent LIKE '%Safari%' THEN 'Safari'
            WHEN user_agent LIKE '%Edg%' THEN 'Edge'
            ELSE 'Other'
          END as browser,
          COUNT(*) as failures
        FROM connection_events
        WHERE event_type IN ('failed','disconnected') AND created_at>=DATE('now','-30 days')
        GROUP BY browser`)),
        safe(env.DB.prepare(`SELECT 
          COUNT(*) as rematches
        FROM sessions s1
        JOIN sessions s2 ON s1.user1_id = s2.user1_id AND s1.user2_id = s2.user2_id
        WHERE s1.created_at < s2.created_at
          AND s2.created_at <= datetime(s1.created_at, '+24 hours')
          AND s2.created_at >= DATE('now','-30 days')
          AND s1.status='completed' AND s2.status='completed'`)),
        safeAll(env.DB.prepare(`SELECT 
          DATE(created_at) as day,
          COUNT(*) as queue_size
        FROM matching_queue
        WHERE created_at>=DATE('now','-30 days')
        GROUP BY DATE(created_at)
        ORDER BY day DESC LIMIT 30`)),
        safe(env.DB.prepare(`SELECT 
          SUM(CASE WHEN activity_type='fp_earned' THEN points ELSE 0 END) as fp_earned,
          SUM(CASE WHEN activity_type='fp_spent' THEN points ELSE 0 END) as fp_spent,
          SUM(CASE WHEN activity_type='rp_earned' THEN points ELSE 0 END) as rp_earned,
          COUNT(DISTINCT user_id) as active_users
        FROM point_transactions
        WHERE created_at>=DATE('now','-30 days')`)),
        safe(env.DB.prepare(`SELECT 
          COUNT(DISTINCT u.id) as total_users,
          SUM(CASE WHEN u.created_at >= DATE('now','-1 day') THEN 1 ELSE 0 END) as d1_users,
          SUM(CASE WHEN u.created_at >= DATE('now','-7 days') THEN 1 ELSE 0 END) as d7_users,
          SUM(CASE WHEN u.created_at >= DATE('now','-30 days') THEN 1 ELSE 0 END) as d30_users
        FROM users u`)),
        safe(env.DB.prepare(`SELECT 
          COUNT(*) as total_reports,
          COUNT(*) * 1000.0 / NULLIF((SELECT COUNT(*) FROM sessions WHERE status='completed' AND created_at>=DATE('now','-30 days')), 0) as reports_per_1000
        FROM user_reports
        WHERE created_at>=DATE('now','-30 days')`)),
      ]);
      
      const sbd=await env.DB.prepare("SELECT DATE(created_at) as day,COUNT(*) as c FROM sessions WHERE created_at>=DATE('now','-30 days') GROUP BY day ORDER BY day DESC LIMIT 30").all().catch(()=>({results:[]}));
      
      return json({
        total_users:tu?.c||0,
        dau:dau?.c||0,
        mau:mau?.c||0,
        total_sessions:ts?.c||0,
        active_sessions:as2?.c||0,
        queue_size:qs?.c||0,
        pending_reports:pr?.c||0,
        new_users_today:nt?.c||0,
        sessions_by_day:sbd.results||[],
        connection_stats:connStats||{},
        session_stats:sessionStats||{},
        queue_stats:queueStats||{},
        cross_border_stats:crossBorderStats||{},
        browser_stats:browserStats?.results||[],
        rematch_stats:rematchStats||{},
        queue_depth_stats:queueDepthStats?.results||[],
        fp_rp_stats:fpRpStats||{},
        retention_stats:retentionStats||{},
        report_stats:reportStats||{}
      });
    }

    // Admin: usage / infrastructure stats
    if(p==='/api/admin/usage'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const today=todayUTC();const monthStart=today.slice(0,7)+'-01';
      const safe=async(q)=>q.first().catch(()=>({}));
      const safeAll=async(q)=>q.all().catch(()=>({results:[]}));
      const[daily,weekly,monthly,totalUsers,totalSessions,totalD1Writes,todaySessions,monthSessions,avgDuration,todayRelay,monthRelay,totalRelay]=await Promise.all([
        safe(env.DB.prepare('SELECT api_requests,d1_reads,d1_writes,do_requests FROM daily_usage WHERE day=?').bind(today)),
        safe(env.DB.prepare("SELECT SUM(api_requests) as api_requests,SUM(d1_reads) as d1_reads,SUM(d1_writes) as d1_writes,SUM(do_requests) as do_requests FROM daily_usage WHERE day>=DATE('now','-7 days')")),
        safe(env.DB.prepare("SELECT SUM(api_requests) as api_requests,SUM(d1_reads) as d1_reads,SUM(d1_writes) as d1_writes,SUM(do_requests) as do_requests FROM daily_usage WHERE day>=?").bind(monthStart)),
        safe(env.DB.prepare('SELECT COUNT(*) as c FROM users')),
        safe(env.DB.prepare('SELECT COUNT(*) as c FROM sessions')),
        safe(env.DB.prepare('SELECT SUM(d1_writes) as c FROM daily_usage')),
        safe(env.DB.prepare("SELECT COUNT(*) as c FROM sessions WHERE created_at>=?").bind(today)),
        safe(env.DB.prepare("SELECT COUNT(*) as c FROM sessions WHERE created_at>=?").bind(monthStart)),
        safe(env.DB.prepare("SELECT AVG(MIN(COALESCE(duration,0),COALESCE(custom_duration,600))) as avg_dur FROM sessions WHERE status='completed' AND created_at>=DATE('now','-30 days')")),
        safe(env.DB.prepare("SELECT COUNT(*) as c FROM sessions WHERE used_relay=1 AND created_at>=?").bind(today)),
        safe(env.DB.prepare("SELECT COUNT(*) as c FROM sessions WHERE used_relay=1 AND created_at>=?").bind(monthStart)),
        safe(env.DB.prepare("SELECT COUNT(*) as c FROM sessions WHERE used_relay=1")),
      ]);
      // Estimate D1 row counts (each user = ~1 row, each session = ~1 row, etc.)
      const userCount=totalUsers?.c||0;const sessionCount=totalSessions?.c||0;
      const estimatedRows=userCount+sessionCount+(userCount*2)+(sessionCount*3);
      const todayRelayCount=todayRelay?.c||0;
      const monthRelayCount=monthRelay?.c||0;
      const totalRelayCount=totalRelay?.c||0;
      const todayP2P=todaySessions?.c-todayRelayCount;
      const monthP2P=monthSessions?.c-monthRelayCount;
      const totalP2P=sessionCount-totalRelayCount;
      return json({
        success:true,
        daily:{api_requests:daily?.api_requests||0,d1_reads:daily?.d1_reads||0,d1_writes:daily?.d1_writes||0,do_requests:daily?.do_requests||0},
        weekly:{api_requests:weekly?.api_requests||0,d1_reads:weekly?.d1_reads||0,d1_writes:weekly?.d1_writes||0,do_requests:weekly?.do_requests||0},
        monthly:{api_requests:monthly?.api_requests||0,d1_reads:monthly?.d1_reads||0,d1_writes:monthly?.d1_writes||0,do_requests:monthly?.do_requests||0},
        estimates:{total_rows:estimatedRows,total_users:userCount,total_sessions:sessionCount,total_d1_writes_all_time:totalD1Writes?.c||0},
        sessions:{today:todaySessions?.c||0,this_month:monthSessions?.c||0,avg_duration:avgDuration?.avg_dur||0},
        relay:{today_relay:todayRelayCount,month_relay:monthRelayCount,total_relay:totalRelayCount,today_p2p:todayP2P>0?todayP2P:0,month_p2p:monthP2P>0?monthP2P:0,total_p2p:totalP2P>0?totalP2P:0},
      });
    }

    // Admin: user search
    if(p==='/api/admin/users'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const{query}=await req.json() as any;
      const q=`%${query||''}%`;
      const users=await env.DB.prepare('SELECT id,username,nickname,email,english_level,fp_balance,rp_balance,is_admin,is_banned,ban_reason,country,native_language,created_at FROM users WHERE username LIKE ? OR email LIKE ? OR nickname LIKE ? ORDER BY created_at DESC LIMIT 50').bind(q,q,q).all();
      return json({success:true,users:users.results});
    }

    // Admin: user detail
    if(p.match(/^\/api\/admin\/user\/[^/]+$/)&&req.method==='POST'){
      const uid=p.split('/')[4];
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const user=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(uid).first();
      const sessions=await env.DB.prepare(`SELECT s.id,s.created_at,s.duration,s.status,CASE WHEN s.user1_id=? THEN u2.username ELSE u1.username END as partner FROM sessions s JOIN users u1 ON s.user1_id=u1.id JOIN users u2 ON s.user2_id=u2.id WHERE s.user1_id=? OR s.user2_id=? ORDER BY s.created_at DESC LIMIT 20`).bind(uid,uid,uid).all();
      const[rm,rr]:any[]= await Promise.all([env.DB.prepare('SELECT COUNT(*) as c FROM user_reports WHERE reporter_id=?').bind(uid).first(),env.DB.prepare('SELECT COUNT(*) as c FROM user_reports WHERE reported_id=?').bind(uid).first()]);
      return json({success:true,user,sessions:sessions.results,reports_made:rm?.c||0,reports_received:rr?.c||0});
    }

    if(p.endsWith('/adjust')&&req.method==='POST'){
      const uid=p.split('/')[4];
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const{fp_delta,rp_delta}=await req.json() as any;
      if(fp_delta)await env.DB.prepare('UPDATE users SET fp_balance=MAX(0,fp_balance+?) WHERE id=?').bind(fp_delta,uid).run();
      if(rp_delta)await env.DB.prepare('UPDATE users SET rp_balance=MAX(0,rp_balance+?) WHERE id=?').bind(rp_delta,uid).run();
      return json({success:true,user:await env.DB.prepare('SELECT fp_balance,rp_balance FROM users WHERE id=?').bind(uid).first()});
    }

    if(p.endsWith('/ban')&&req.method==='POST'){
      const uid=p.split('/')[4];
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const{reason}=await req.json() as any;
      await env.DB.prepare('UPDATE users SET is_banned=1,ban_reason=? WHERE id=?').bind(reason||'Policy violation',uid).run();
      return json({success:true});
    }

    if(p.endsWith('/unban')&&req.method==='POST'){
      const uid=p.split('/')[4];
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      await env.DB.prepare("UPDATE users SET is_banned=0,ban_reason='' WHERE id=?").bind(uid).run();
      return json({success:true});
    }

    if(p.endsWith('/founding-member')&&req.method==='POST'){
      const uid=p.split('/')[4];
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const u:any=await env.DB.prepare('SELECT founding_member_override FROM users WHERE id=?').bind(uid).first();
      if(!u)return json({error:'User not found'},404);
      const newVal=u.founding_member_override?0:1;
      await env.DB.prepare('UPDATE users SET founding_member_override=? WHERE id=?').bind(newVal,uid).run();
      return json({success:true,founding_member_override:newVal});
    }

    // Admin: create user
    if(p==='/api/admin/user/create'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const{username,email,english_level,country,native_language}=await req.json() as any;
      if(!username||!email)return json({error:'Username and email required'},400);
      const exists:any=await env.DB.prepare('SELECT id FROM users WHERE email=? OR username=?').bind(email,username).first();
      if(exists)return json({error:'Email or username already exists'},409);
      const id=uuid();
      const cfg=await getSettings(env.DB);
      const initRp=cfg.promoInitialRp||0;
      await env.DB.prepare("INSERT INTO users(id,username,email,password_hash,english_level,fp_balance,fp_last_reset,rp_balance,country,native_language,created_at)VALUES(?,?,?,'admin_created',?,1,?,?,?,datetime('now'))").bind(id,username,email,english_level||'beginner',todayUTC(),initRp,country||'',native_language||'').run();
      if(initRp>0)await env.DB.prepare("INSERT INTO point_transactions(id,user_id,points,activity_type,session_id,created_at)VALUES(?,?,?,'promo_registration_bonus',NULL,datetime('now'))").bind(uuid(),id,initRp).run().catch(()=>{});
      const user=await env.DB.prepare('SELECT id,username,nickname,email,english_level,fp_balance,rp_balance,is_admin,is_banned,ban_reason,country,native_language,created_at FROM users WHERE id=?').bind(id).first();
      return json({success:true,user});
    }

    // Admin: update user
    if(p.match(/^\/api\/admin\/user\/[^/]+\/update$/)&&req.method==='POST'){
      const uid=p.split('/')[4];
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const{username,email,english_level,country,native_language,nickname}=await req.json() as any;
      // Check uniqueness if changing username or email
      if(username){
        const dupe:any=await env.DB.prepare('SELECT id FROM users WHERE username=? AND id!=?').bind(username,uid).first();
        if(dupe)return json({error:'Username already taken'},409);
      }
      if(email){
        const dupe:any=await env.DB.prepare('SELECT id FROM users WHERE email=? AND id!=?').bind(email,uid).first();
        if(dupe)return json({error:'Email already exists'},409);
      }
      const fields=[];const vals=[];
      if(username){fields.push('username=?');vals.push(username);}
      if(email){fields.push('email=?');vals.push(email);}
      if(english_level){fields.push('english_level=?');vals.push(english_level);}
      if(country!==undefined){fields.push('country=?');vals.push(country);}
      if(native_language!==undefined){fields.push('native_language=?');vals.push(native_language);}
      if(nickname!==undefined){fields.push('nickname=?');vals.push(nickname);}
      if(fields.length===0)return json({error:'No fields to update'},400);
      vals.push(uid);
      await env.DB.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
      const user=await env.DB.prepare('SELECT id,username,nickname,email,english_level,fp_balance,rp_balance,is_admin,is_banned,ban_reason,country,native_language,created_at FROM users WHERE id=?').bind(uid).first();
      return json({success:true,user});
    }

    // Admin: delete user
    if(p.match(/^\/api\/admin\/user\/[^/]+\/delete$/)&&req.method==='POST'){
      const uid=p.split('/')[4];
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const u:any=await env.DB.prepare('SELECT is_admin FROM users WHERE id=?').bind(uid).first();
      if(!u)return json({error:'User not found'},404);
      if(u.is_admin)return json({error:'Cannot delete admin users'},400);
      await env.DB.prepare('DELETE FROM matching_queue WHERE user_id=?').bind(uid).run();
      await env.DB.prepare('DELETE FROM user_blocks WHERE blocker_id=? OR blocked_id=?').bind(uid,uid).run();
      await env.DB.prepare('DELETE FROM user_reports WHERE reporter_id=? OR reported_id=?').bind(uid,uid).run();
      await env.DB.prepare('DELETE FROM friend_requests WHERE sender_id=? OR receiver_id=?').bind(uid,uid).run();
      await env.DB.prepare('DELETE FROM friends WHERE user_id=? OR friend_id=?').bind(uid,uid).run();
      await env.DB.prepare('DELETE FROM invites WHERE inviter_id=? OR invitee_id=?').bind(uid,uid).run();
      await env.DB.prepare('DELETE FROM point_transactions WHERE user_id=? OR session_id IN(SELECT id FROM sessions WHERE user1_id=? OR user2_id=?)').bind(uid,uid,uid).run();
      await env.DB.prepare('DELETE FROM connection_events WHERE user_id=? OR session_id IN(SELECT id FROM sessions WHERE user1_id=? OR user2_id=?)').bind(uid,uid,uid).run();
      await env.DB.prepare('DELETE FROM user_reports WHERE session_id IN(SELECT id FROM sessions WHERE user1_id=? OR user2_id=?)').bind(uid,uid).run();
      await env.DB.prepare('DELETE FROM sessions WHERE user1_id=? OR user2_id=?').bind(uid,uid).run();
      await env.DB.prepare('DELETE FROM users WHERE id=?').bind(uid).run();
      return json({success:true});
    }

    if(p==='/api/admin/reports'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const{status}=await req.json() as any;
      const reports=await env.DB.prepare(`SELECT r.*,u1.username as reporter_name,u2.username as reported_name,u2.email as reported_email FROM user_reports r JOIN users u1 ON r.reporter_id=u1.id JOIN users u2 ON r.reported_id=u2.id WHERE r.status=? ORDER BY r.created_at DESC LIMIT 100`).bind(status||'pending').all();
      return json({success:true,reports:reports.results});
    }

    if(p.match(/^\/api\/admin\/report\/[^/]+\/action$/)&&req.method==='POST'){
      const rid=p.split('/')[4];
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const{action,note}=await req.json() as any;
      await env.DB.prepare('UPDATE user_reports SET status=?,admin_note=? WHERE id=?').bind(action==='dismiss'?'reviewed':'actioned',note||'',rid).run();
      return json({success:true});
    }

    // ── SIGNAL ─────────────────────────────────────────────────
    // Refund FP if session never connected
    if(p==='/api/matching/refund-fp'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{session_id}=await req.json() as any;
      const sess:any=await env.DB.prepare('SELECT * FROM sessions WHERE id=?').bind(session_id).first();
      if(!sess)return json({success:false,error:'Session not found'});
      // Only refund if session was never completed (still active or just created)
      if(sess.status==='active'){
        await env.DB.batch([
          env.DB.prepare('UPDATE users SET fp_balance=fp_balance+1 WHERE id=?').bind(sess.user1_id),
          env.DB.prepare('UPDATE users SET fp_balance=fp_balance+1 WHERE id=?').bind(sess.user2_id),
          env.DB.prepare("UPDATE sessions SET status='failed' WHERE id=?").bind(session_id),
        ]);
        return json({success:true,refunded:true});
      }
      return json({success:true,refunded:false});
    }

    // Connection event logging
    if(p==='/api/connection/event'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      const{session_id,event_type,event_data,user_agent}=await req.json() as any;
      if(!session_id||!event_type)return json({success:false,error:'Missing fields'},400);
      const id=uuid();
      await env.DB.prepare("INSERT INTO connection_events(id,session_id,user_id,event_type,event_data,user_agent,created_at)VALUES(?,?,?,?,?,?,datetime('now'))").bind(id,session_id,auth.userId,event_type,event_data||'{}',user_agent||'').run().catch(()=>{});
      // Update session with connection timestamps
      if(event_type==='connected'){
        await env.DB.prepare("UPDATE sessions SET connected_at=datetime('now') WHERE id=? AND connected_at IS NULL").bind(session_id).run().catch(()=>{});
      }
      if(event_type==='failed' || event_type==='disconnected'){
        const reason=event_type==='failed'?'ice_failed':'disconnected';
        await env.DB.prepare("UPDATE sessions SET disconnect_reason=? WHERE id=? AND disconnect_reason IS NULL").bind(reason,session_id).run().catch(()=>{});
      }
      return json({success:true});
    }

    // Admin: all users paginated
    if(p==='/api/admin/users/all'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const{offset=0,limit=50}=await req.json() as any;
      const cfg=await getSettings(env.DB);
      const[total,users]:any[]= await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as c FROM users').first(),
        env.DB.prepare('SELECT id,username,nickname,email,english_level,fp_balance,rp_balance,is_admin,is_banned,country,native_language,created_at,founding_member_override FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(limit,offset).all(),
      ]);
      for(const u of (users.results||[]))u.is_new_member=isNewMember(u.created_at,cfg.newMemberDays);
      return json({success:true,users:users.results||[],total:total?.c||0});
    }

    // Admin: export all users as CSV
    if(p==='/api/admin/users/export'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const users=await env.DB.prepare('SELECT id,username,nickname,email,english_level,fp_balance,rp_balance,is_admin,is_banned,ban_reason,country,native_language,created_at,last_active FROM users ORDER BY created_at DESC').all();
      const rows=users.results||[];
      const headers=['id','username','nickname','email','english_level','fp_balance','rp_balance','is_admin','is_banned','ban_reason','country','native_language','created_at','last_active'];
      const escape=(v:any)=>v==null?'':String(v).replace(/"/g,'""');
      const csv=[headers.join(','),...rows.map((r:any)=>headers.map(h=>`"${escape(r[h])}"`).join(','))].join('\n');
      return json({success:true,csv});
    }

    // Admin: get online/searching/in-call status for specific users
    if(p==='/api/admin/users/status'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const{user_ids=[]}=await req.json() as any;
      if(!user_ids.length)return json({success:true,statuses:{}});
      const placeholders=user_ids.map(()=>'?').join(',');
      const[queue,inCall,online]:any[]=await Promise.all([
        env.DB.prepare(`SELECT user_id FROM matching_queue WHERE user_id IN (${placeholders})`).bind(...user_ids).all(),
        env.DB.prepare(`SELECT user1_id,user2_id FROM sessions WHERE status='active' AND (user1_id IN (${placeholders}) OR user2_id IN (${placeholders}))`).bind(...user_ids,...user_ids).all(),
        env.DB.prepare(`SELECT id FROM users WHERE last_active>=datetime('now','-2 minutes') AND id IN (${placeholders})`).bind(...user_ids).all(),
      ]);
      const statuses:Record<string,string>={};
      for(const id of user_ids)statuses[id]='offline';
      for(const r of online.results||[])statuses[r.id]='online';
      for(const r of queue.results||[])statuses[r.user_id]='searching';
      for(const r of inCall.results||[]){statuses[r.user1_id]='in_call';statuses[r.user2_id]='in_call';}
      return json({success:true,statuses});
    }

    // Admin: referral stats
    if(p==='/api/admin/referrals'&&req.method==='POST'){
      const auth=await requireAuth(env,req);
      if(auth instanceof Response)return auth;
      if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const[totalReferrals,totalRpGiven]:any[]=await Promise.all([
        env.DB.prepare("SELECT COUNT(DISTINCT inviter_id||'-'||invitee_id) as c FROM invites WHERE used=1 AND invitee_id IS NOT NULL").first(),
        env.DB.prepare("SELECT COALESCE(SUM(points),0) as total FROM point_transactions WHERE activity_type='referral_bonus'").first(),
      ]);
      const recent:any=await env.DB.prepare(`
        SELECT i.inviter_id,i.invitee_id,MAX(i.created_at) as created_at,
          u1.username as referrer_name,u1.nickname as referrer_nickname,u1.email as referrer_email,
          u2.username as invitee_name,u2.nickname as invitee_nickname,u2.email as invitee_email
        FROM invites i
        LEFT JOIN users u1 ON i.inviter_id=u1.id
        LEFT JOIN users u2 ON i.invitee_id=u2.id
        WHERE i.used=1 AND i.invitee_id IS NOT NULL
        GROUP BY i.inviter_id,i.invitee_id
        ORDER BY created_at DESC
        LIMIT 100
      `).all().catch(()=>({results:[]}));
      return json({success:true,total_referrals:totalReferrals?.c||0,total_rp_given:totalRpGiven?.total||0,transactions:recent.results||[]});
    }

    // ── Blog Posts (Admin CRUD) ─────────────────────────────────
    if(p==='/api/admin/blog/list'&&req.method==='POST'){
      const auth=await requireAuth(env,req);if(auth instanceof Response)return auth;if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const posts=await env.DB.prepare('SELECT p.id,p.slug,p.title,p.excerpt,p.status,p.lang,p.created_at,p.updated_at,(SELECT COUNT(*) FROM blog_posts t WHERE t.parent_id=p.id) as translation_count FROM blog_posts p WHERE p.parent_id IS NULL ORDER BY p.created_at DESC').all();
      return json({success:true,posts:posts.results||[]});
    }
    if(p==='/api/admin/blog/create'&&req.method==='POST'){
      const auth=await requireAuth(env,req);if(auth instanceof Response)return auth;if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const{slug,title,excerpt,content,status,lang}=await req.json() as any;
      if(!slug||!title||!content)return json({success:false,error:'Slug, title, and content are required'});
      const id=uuid();
      await env.DB.prepare('INSERT INTO blog_posts(id,slug,title,excerpt,content,author_id,status,lang,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,datetime(\'now\'),datetime(\'now\'))').bind(id,slug,title,excerpt||'',content,auth.userId,status||'draft',lang||'en').run();
      if(status==='published'&&lang==='en')translateBlogPost(env.DB,id,title,excerpt||'',content).catch(()=>{});
      return json({success:true,id});
    }
    if(p==='/api/admin/blog/update'&&req.method==='POST'){
      const auth=await requireAuth(env,req);if(auth instanceof Response)return auth;if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const{id,slug,title,excerpt,content,status,lang}=await req.json() as any;
      if(!id)return json({success:false,error:'Post ID required'});
      await env.DB.prepare('UPDATE blog_posts SET slug=?,title=?,excerpt=?,content=?,status=?,lang=?,updated_at=datetime(\'now\') WHERE id=?').bind(slug,title,excerpt||'',content,status||'draft',lang||'en',id).run();
      if(status==='published'&&lang==='en'){
        await env.DB.prepare("DELETE FROM blog_posts WHERE parent_id=?").bind(id).run().catch(()=>{});
        translateBlogPost(env.DB,id,title,excerpt||'',content).catch(()=>{});
      }
      return json({success:true});
    }
    if(p==='/api/admin/blog/delete'&&req.method==='POST'){
      const auth=await requireAuth(env,req);if(auth instanceof Response)return auth;if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const{id}=await req.json() as any;
      if(!id)return json({success:false,error:'Post ID required'});
      await env.DB.prepare("DELETE FROM blog_posts WHERE parent_id=?").bind(id).run().catch(()=>{});
      await env.DB.prepare('DELETE FROM blog_posts WHERE id=?').bind(id).run();
      return json({success:true});
    }
    if(p==='/api/admin/blog/retranslate'&&req.method==='POST'){
      const auth=await requireAuth(env,req);if(auth instanceof Response)return auth;if(!auth.isAdmin)return json({error:'Unauthorized'},403);
      const{id}=await req.json() as any;
      if(!id)return json({success:false,error:'Post ID required'});
      const post=await env.DB.prepare('SELECT * FROM blog_posts WHERE id=?').bind(id).first();
      if(!post)return json({success:false,error:'Post not found'});
      await env.DB.prepare("DELETE FROM blog_posts WHERE parent_id=?").bind(id).run().catch(()=>{});
      await translateBlogPost(env.DB,id,post.title,post.excerpt,post.content);
      return json({success:true,message:'Translations complete'});
    }
    // Public blog endpoints
    if(p==='/api/blog/list'&&req.method==='GET'){
      const lang=url.searchParams.get('lang')||'en';
      const posts=await env.DB.prepare('SELECT id,slug,title,excerpt,status,lang,created_at,updated_at FROM blog_posts WHERE status=\'published\' AND lang=? ORDER BY created_at DESC').bind(lang).all();
      const fallback=await env.DB.prepare('SELECT id,slug,title,excerpt,status,lang,created_at,updated_at FROM blog_posts WHERE status=\'published\' AND lang=\'en\' ORDER BY created_at DESC').all();
      return json({success:true,posts:lang==='en'?(posts.results||[]):(posts.results||[]).length>0?posts.results:fallback.results||[]});
    }
    if(p==='/api/blog/post'&&req.method==='GET'){
      const slug=url.searchParams.get('slug');
      if(!slug)return json({success:false,error:'Slug required'});
      const post=await env.DB.prepare('SELECT * FROM blog_posts WHERE slug=? AND status=\'published\'').bind(slug).first();
      if(!post)return json({success:false,error:'Post not found'});
      return json({success:true,post});
    }

    // ── Leaderboard ──────────────────────────────────────────
    if(p==='/api/leaderboard'){
      const mode=url.searchParams.get('mode')||'all-time';
      const dateFilter=mode==='weekly'?"AND s.created_at>=DATE('now','-7 days')":'';
      const q=await env.DB.prepare(`
        SELECT u.id,u.nickname,u.username,u.streak_count,
          COALESCE(SUM(s.duration),0) as total_duration,
          COUNT(s.id) as total_sessions
        FROM users u
        LEFT JOIN sessions s ON (s.user1_id=u.id OR s.user2_id=u.id)
          AND s.status='completed' ${dateFilter}
        GROUP BY u.id
        HAVING total_sessions > 0
        ORDER BY (total_duration/60 + total_sessions*5 + u.streak_count*2) DESC
        LIMIT 10
      `).all().catch(()=>({results:[]}));
      const results=(q.results||[]).map((r,i)=>({
        rank:i+1,
        username:r.username,
        nickname:r.nickname||r.username,
        streak:r.streak_count||0,
        totalDuration:r.total_duration||0,
        totalSessions:r.total_sessions||0,
        score:Math.round((r.total_duration||0)/60+(r.total_sessions||0)*5+(r.streak_count||0)*2)
      }));
      return json({success:true,mode,leaderboard:results});
    }

    if(p==='/api/signal'){
      const sid=url.searchParams.get('sessionId');
      if(!sid)return new Response('Missing sessionId',{status:400});
      return env.SIGNALING.get(env.SIGNALING.idFromName(sid)).fetch(req);
    }

    return new Response('Not Found',{status:404,headers:cors});
    }catch(e:any){return json({error:e?.message||String(e)},500);}
  },
};
