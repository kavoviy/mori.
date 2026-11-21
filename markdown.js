// Без сторонних библиотек. Пользовательский Markdown сначала экранируется:
// никакой произвольный HTML/JS из заметок не выполняется.
export function escapeHTML(text='') {
  return String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
export function safeUrl(raw='') {
  try {
    const input = String(raw).trim();
    const value = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    const u = new URL(value);
    return ['http:','https:'].includes(u.protocol) && u.hostname ? u.href : '';
  } catch { return ''; }
}
const tokenPattern = /(`[^`\n]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>"`]+|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*)/gi;

export function renderInline(raw='', depth=0) {
  if (depth > 3) return escapeHTML(raw);
  const source = String(raw);
  const re = new RegExp(tokenPattern.source,'gi');
  let html = '', pos=0, m;
  while ((m=re.exec(source))) {
    html += escapeHTML(source.slice(pos,m.index));
    const item=m[0];
    if (item.startsWith('`')) html += `<code>${escapeHTML(item.slice(1,-1))}</code>`;
    else if (item.startsWith('**')) html += `<strong>${renderInline(item.slice(2,-2),depth+1)}</strong>`;
    else if (item.startsWith('~~')) html += `<del>${renderInline(item.slice(2,-2),depth+1)}</del>`;
    else if (item.startsWith('*')) html += `<em>${renderInline(item.slice(1,-1),depth+1)}</em>`;
    else if (item.startsWith('[')) {
      const match=/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/i.exec(item);
      const url=match && safeUrl(match[2]);
      html += url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${renderInline(match[1],depth+1)}</a>` : escapeHTML(item);
    } else {
      const clean=item.replace(/[.,!?;:]+$/,'');
      const url=safeUrl(clean);
      html += url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(clean)}</a>${escapeHTML(item.slice(clean.length))}` : escapeHTML(item);
    }
    pos=m.index+item.length;
  }
  return html + escapeHTML(source.slice(pos));
}

export function renderMarkdown(markdown='') {
  const lines=String(markdown).replace(/\r\n?/g,'\n').split('\n');
  const out=[];
  let i=0;
  while (i<lines.length) {
    const line=lines[i];
    if (!line.trim()) {i++;continue;}
    if (/^```/.test(line)) {
      const code=[];i++;
      while(i<lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      if(i<lines.length)i++;
      out.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`);continue;
    }
    const heading=/^(#{1,3})\s+(.+)$/.exec(line);
    if(heading){const n=heading[1].length;out.push(`<h${n}>${renderInline(heading[2])}</h${n}>`);i++;continue;}
    if(/^\s*(---+|\*\*\*+)\s*$/.test(line)){out.push('<hr>');i++;continue;}
    if(/^>\s?/.test(line)){
      const body=[];
      while(i<lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/,''));
      out.push(`<blockquote>${body.map(renderInline).join('<br>')}</blockquote>`);continue;
    }
    if(/^\s*([-*+] |\d+\. )/.test(line)){
      const ordered=/^\s*\d+\. /.test(line),items=[];
      while(i<lines.length && /^\s*([-*+] |\d+\. )/.test(lines[i])){
        const raw=lines[i++].replace(/^\s*(?:[-*+] |\d+\. )/,'');
        const check=/^\[([ xX])\]\s*(.*)$/.exec(raw);
        items.push(`<li>${check ? (check[1].toLowerCase()==='x'?'☑ ':'☐ ')+renderInline(check[2]) : renderInline(raw)}</li>`);
      }
      out.push(`<${ordered?'ol':'ul'}>${items.join('')}</${ordered?'ol':'ul'}>`);continue;
    }
    const paragraph=[];
    while(i<lines.length && lines[i].trim() && !/^(?:#{1,3}\s|```|>\s?|\s*[-*+] |\s*\d+\. |\s*---+\s*$)/.test(lines[i])) paragraph.push(lines[i++]);
    if(paragraph.length)out.push(`<p>${paragraph.map(x=>renderInline(x)).join('<br>')}</p>`);
    else {out.push(`<p>${renderInline(lines[i])}</p>`);i++;}
  }
  return out.join('\n') || '<p class="preview-empty">Пока здесь пусто.</p>';
}
