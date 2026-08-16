const crypto = require('crypto');
const fs = require('fs');

const POST_ID = 'c23b4743-7dc0-4f40-8bfc-a71068f8b7b1';
const SLUG = 'daily-5-minute-english-speaking-habit';
const NOW = new Date().toISOString().replace('T', ' ').slice(0, 19);

const LANGUAGES = [
  { code: 'es', title: 'Cómo desarrollar un hábito diario de hablar inglés de 5 minutos', excerpt: 'Desarrolle el hábito diario de hablar inglés en solo 5 minutos. Aprenda formas sencillas de practicar con consistencia, hable con confianza y haga del inglés parte de su vida cotidiana.' },
  { code: 'ja', title: '毎日5分間英語を話す習慣を築く方法', excerpt: 'わずか5分で毎日英語を話す習慣を身につけましょう。継続的に練習する簡単な方法を学び、自信を持って話し、英語を日常生活の一部にしましょう。' },
  { code: 'zh', title: '如何养成每天 5 分钟说英语的习惯', excerpt: '只需 5 分钟即可养成日常英语口语的习惯。学习简单的方法来持续练习、自信地说话并使英语成为您日常生活的一部分。' },
  { code: 'bn', title: 'কিভাবে দৈনিক 5 মিনিটের ইংরেজি বলার অভ্যাস গড়ে তুলবেন', excerpt: 'মাত্র 5 মিনিটে দৈনিক ইংরেজি বলার অভ্যাস গড়ে তুলুন। ধারাবাহিকভাবে অনুশীলনের সহজ উপায় শিখুন, আত্মবিশ্বাসের সাথে কথা বলুন এবং ইংরেজিকে আপনার দৈনিক জীবনের অংশ করুন।' },
  { code: 'fr', title: "Comment créer une habitude quotidienne de parler anglais de 5 minutes", excerpt: "Construisez une habitude quotidienne de parler anglais en seulement 5 minutes. Apprenez des moyens simples de pratiquer régulièrement, parlez avec confiance et faites de l'anglais partie de votre vie quotidienne." },
  { code: 'ar', title: 'كيفية بناء عادة التحدث باللغة الإنجليزية لمدة 5 دقائق يوميًا', excerpt: 'قم ببناء عادة التحدث باللغة الإنجليزية يوميًا في 5 دقائق فقط. تعلم طرق بسيطة للممارسة بانتظام، وتحدث بثقة واجعل اللغة الإنجليزية جزءًا من حياتك اليومية.' },
  { code: 'ru', title: 'Как выработать ежедневную пятиминутную привычку говорить по-английски', excerpt: 'Выработайте ежедневную привычку говорить по-английски всего за 5 минут. Изучите простые способы постоянной практики, говорите уверенно и сделайте английский частью вашей повседневной жизни.' },
];

const CONTENT_EN = `<p>You want to speak English better, but studying for an hour every day isn't always realistic. Work, school, and everyday life can easily get in the way.</p>
<p>That's why starting with just <strong>5 minutes of English speaking every day</strong> can be a simple way to build a sustainable habit. Five minutes is short enough to fit into a busy day. The important thing is to make speaking English a regular part of your life.</p>
<h2>1. Speak at the Same Time Every Day</h2>
<p>Instead of thinking, "I'll practice when I have time," choose a regular time for your English conversation.</p>
<p>For example:</p>
<ul><li>After breakfast</li><li>After work or school</li><li>After dinner</li><li>Before going to bed</li></ul>
<p>Try connecting your English practice to something you already do every day. For example: <strong>"After dinner, I'll speak English for 5 minutes."</strong> This makes it easier to turn English speaking into a daily routine.</p>
<h2>2. Don't Try to Speak Perfect English</h2>
<p>Many English learners worry about making mistakes: "What if my grammar is wrong?" or "What if I don't know the right word?"</p>
<p>But your goal during these five minutes isn't to speak perfect English. Your goal is simply to <strong>communicate with another person in English</strong>.</p>
<p>If you don't know a word, try explaining it in a simpler way. If you make a mistake, keep talking. The more comfortable you become with making mistakes, the easier it becomes to speak.</p>
<h2>3. Choose One Simple Topic Every Day</h2>
<p>Sometimes the hardest part of speaking English is simply knowing what to talk about. Before your conversation, choose one easy topic.</p>
<p>For example:</p>
<ul><li>What happened today</li><li>Your favorite food</li><li>Your hobbies</li><li>A country you want to visit</li><li>A movie or TV show you recently watched</li><li>Your weekend plans</li></ul>
<p>You don't need complicated topics. Talking about everyday life helps you practice the kind of English you can actually use in real conversations.</p>
<h2>4. Think of It as a Conversation, Not Studying</h2>
<p>If you want to keep practicing every day, English shouldn't always feel like homework.</p>
<p>Talk to someone from another country for five minutes. Ask them about where they live. Tell them about something you enjoy.</p>
<p>Small conversations like these can change English from something you <strong>study</strong> into something you <strong>use to connect with people</strong>. And that can make practicing much more enjoyable.</p>
<h2>5. Start With Just 5 Minutes</h2>
<p>You don't need to begin with long study sessions to build an English-speaking habit. Start with <strong>5 minutes a day</strong>.</p>
<p>With Chatter3, you can have <strong>free 5-minute one-on-one English conversations with language learners from around the world</strong>.</p>
<p>Log in, find a partner, and start talking when you're matched. Make speaking English part of your everyday life—not something you only do occasionally.</p>
<p><strong><a href="https://app.chatter3.com/">Start your 5-minute conversation today.</a></strong></p>
<p><strong>Connect. Speak. Earn.</strong></p>`;

async function translate(text, tl) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + tl + '&dt=t&q=' + encodeURIComponent(text);
  const r = await fetch(url);
  const d = await r.json();
  return d[0].map(s => s[0]).join('');
}

async function translateHTML(html, tl) {
  const tokens = html.split(/(<[^>]+>)/);
  const textIndices = [];
  const texts = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].startsWith('<') && tokens[i].trim().length > 0) {
      textIndices.push(i);
      texts.push(tokens[i]);
    }
  }
  const translated = [];
  for (let i = 0; i < texts.length; i += 5) {
    const batch = texts.slice(i, i + 5);
    const results = await Promise.all(batch.map(t => translate(t, tl)));
    translated.push(...results);
  }
  let ti = 0;
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].startsWith('<') && tokens[i].trim().length > 0) {
      result.push(translated[ti++]);
    } else {
      result.push(tokens[i]);
    }
  }
  return result.join('');
}

async function main() {
  // Build INSERT statements as a JSON array that we'll pass via stdin
  const inserts = [];
  for (const lang of LANGUAGES) {
    process.stdout.write('Translating ' + lang.code + '... ');
    const content = await translateHTML(CONTENT_EN, lang.tl);
    const id = crypto.randomUUID();
    const slug = SLUG + '-' + lang.code;
    inserts.push({
      id, slug, title: lang.title, excerpt: lang.excerpt, content,
      lang: lang.code, parent_id: POST_ID, created_at: NOW, updated_at: NOW
    });
    console.log('OK');
  }
  
  // Write each insert as a separate SQL file to ensure proper encoding
  for (const ins of inserts) {
    const sql = `INSERT INTO blog_posts (id, slug, title, excerpt, content, author_id, status, lang, parent_id, created_at, updated_at) VALUES ('${ins.id}', '${ins.slug}', '${ins.title.replace(/'/g, "''")}', '${ins.excerpt.replace(/'/g, "''")}', '${ins.content.replace(/'/g, "''")}', 'system', 'published', '${ins.lang}', '${ins.parent_id}', '${ins.created_at}', '${ins.updated_at}');`;
    const sqlFile = 'C:\\Users\\Rahman-Khan\\chatter3-backend\\tmp_' + ins.lang + '.sql';
    // Write with UTF-8 BOM to ensure proper encoding
    const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
    fs.writeFileSync(sqlFile, BOM + sql, { encoding: 'utf8' });
    console.log('Wrote SQL for ' + ins.lang);
  }
  
  console.log('Now run: npx wrangler d1 execute chatter3-db --remote --file tmp_es.sql');
}

main().catch(console.error);
