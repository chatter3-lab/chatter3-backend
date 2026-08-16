const crypto = require('crypto');
const fs = require('fs');

const POST_ID = 'c23b4743-7dc0-4f40-8bfc-a71068f8b7b1';
const SLUG = 'daily-5-minute-english-speaking-habit';
const TITLE = 'How to Build a Daily 5-Minute English Speaking Habit';
const EXCERPT = 'Build a daily English speaking habit in just 5 minutes. Learn simple ways to practice consistently, speak with confidence, and make English part of your everyday life.';
const CONTENT = `<p>You want to speak English better, but studying for an hour every day isn't always realistic. Work, school, and everyday life can easily get in the way.</p>
<p>That's why starting with just <strong>5 minutes of English speaking every day</strong> can be a simple way to build a sustainable habit. Five minutes is short enough to fit into a busy day. The important thing is to make speaking English a regular part of your life.</p>
<h2>1. Speak at the Same Time Every Day</h2>
<p>Instead of thinking, "I'll practice when I have time," choose a regular time for your English conversation.</p>
<p>For example:</p>
<ul>
  <li>After breakfast</li>
  <li>After work or school</li>
  <li>After dinner</li>
  <li>Before going to bed</li>
</ul>
<p>Try connecting your English practice to something you already do every day. For example: <strong>"After dinner, I'll speak English for 5 minutes."</strong> This makes it easier to turn English speaking into a daily routine.</p>
<h2>2. Don't Try to Speak Perfect English</h2>
<p>Many English learners worry about making mistakes: "What if my grammar is wrong?" or "What if I don't know the right word?"</p>
<p>But your goal during these five minutes isn't to speak perfect English. Your goal is simply to <strong>communicate with another person in English</strong>.</p>
<p>If you don't know a word, try explaining it in a simpler way. If you make a mistake, keep talking. The more comfortable you become with making mistakes, the easier it becomes to speak.</p>
<h2>3. Choose One Simple Topic Every Day</h2>
<p>Sometimes the hardest part of speaking English is simply knowing what to talk about. Before your conversation, choose one easy topic.</p>
<p>For example:</p>
<ul>
  <li>What happened today</li>
  <li>Your favorite food</li>
  <li>Your hobbies</li>
  <li>A country you want to visit</li>
  <li>A movie or TV show you recently watched</li>
  <li>Your weekend plans</li>
</ul>
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

const LANGUAGES = [
  { code: 'es', tl: 'es' },
  { code: 'ja', tl: 'ja' },
  { code: 'zh', tl: 'zh-CN' },
  { code: 'bn', tl: 'bn' },
  { code: 'fr', tl: 'fr' },
  { code: 'ar', tl: 'ar' },
  { code: 'ru', tl: 'ru' },
];

async function translate(text, tl) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + tl + '&dt=t&q=' + encodeURIComponent(text);
  const r = await fetch(url);
  const d = await r.json();
  return d[0].map(s => s[0]).join('');
}

async function translateHTML(html, tl) {
  // Split by HTML tags, translate only text nodes
  const tokens = html.split(/(<[^>]+>)/);
  const result = [];
  // Batch text nodes for fewer API calls
  const textIndices = [];
  const texts = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].startsWith('<') && tokens[i].trim().length > 0) {
      textIndices.push(i);
      texts.push(tokens[i]);
    }
  }
  // Translate in batches of 5
  const translated = [];
  for (let i = 0; i < texts.length; i += 5) {
    const batch = texts.slice(i, i + 5);
    const results = await Promise.all(batch.map(t => translate(t, tl)));
    translated.push(...results);
  }
  let ti = 0;
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
  let sql = '';
  for (const lang of LANGUAGES) {
    process.stdout.write('Translating ' + lang.code + '... ');
    const title = await translate(TITLE, lang.tl);
    const excerpt = await translate(EXCERPT, lang.tl);
    const content = await translateHTML(CONTENT, lang.tl);
    const slug = SLUG + '-' + lang.code;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const id = crypto.randomUUID();
    const esc = (s) => s.replace(/'/g, "''");
    sql += `INSERT INTO blog_posts (id, slug, title, excerpt, content, author_id, status, lang, parent_id, created_at, updated_at) VALUES ('${id}', '${esc(slug)}', '${esc(title)}', '${esc(excerpt)}', '${esc(content)}', 'system', 'published', '${lang.code}', '${POST_ID}', '${now}', '${now}');\n`;
    console.log('OK - ' + title);
  }
  fs.writeFileSync('C:\\Users\\Rahman-Khan\\chatter3-backend\\translations.sql', sql);
  console.log('SQL written to translations.sql');
}

main().catch(console.error);
