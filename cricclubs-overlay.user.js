// ==UserScript==
// @name         CricClubs Score Overlay
// @namespace    cricclubs-overlay
// @version      3.0
// @description  Live CricClubs scorebar. #overlay on a scorecard URL draws it in the tab; #ccbridge feeds a hosted overlay page that embeds the scorecard.
// @match        https://cricclubs.com/*viewScorecard.do*
// @match        https://www.cricclubs.com/*viewScorecard.do*
// @match        https://cricclubs.com/*ballbyball.do*
// @match        https://www.cricclubs.com/*ballbyball.do*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Userscript mode: only take over when the URL has #overlay (draw here) or #ccbridge (feed a hosted page).
  // Bookmarklet / console mode (no GM_info): always draw here.
  const hash = location.hash.replace(/^#/, '');
  const BRIDGE = /(^|&)ccbridge\b/.test(hash);
  if (typeof GM_info !== 'undefined' && !BRIDGE && !/(^|&)overlay\b/.test(hash)) return;

  // Options via hash, e.g. #overlay&bg=transparent&refresh=10&scale=1.5
  const opts = Object.fromEntries(hash.split('&').map(p => p.split('=')));
  const BG = opts.bg ? (/^[0-9a-f]{3,8}$/i.test(opts.bg) ? '#' + opts.bg : opts.bg) : '#00ff00';
  const REFRESH_MS = Math.max(5, Number(opts.refresh) || 15) * 1000;
  const SCALE = Number(opts.scale) || 1;

  // Stop the page's own 60s full-page reload; we poll instead.
  const maxId = setTimeout(() => {}, 0);
  for (let i = 0; i <= maxId; i++) { clearTimeout(i); clearInterval(i); }

  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const BALL_CLASS = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', wicket: 'W', wide: 'wd', noball: 'nb' };

  // "Pankaj Chauhan" -> "PANKAJ C"
  const shortName = n => {
    const w = clean(n).replace(/[*†]/g, '').split(' ').filter(Boolean);
    return (w.length > 1 ? w[0] + ' ' + w[w.length - 1][0] : w[0] || '').toUpperCase();
  };
  // "DareDevils" -> "DD", "Challengers" -> "CHL", "Boston Strikers" -> "BS"
  const teamCode = n => {
    const name = clean(n);
    const words = name.split(' ').filter(Boolean);
    if (words.length > 1) return words.map(w => w[0]).join('').slice(0, 3).toUpperCase();
    const caps = name.replace(/[^A-Z]/g, '');
    if (caps.length >= 2) return caps.slice(0, 3);
    return (name[0] + name.slice(1).replace(/[aeiou\W\d]/gi, '')).slice(0, 3).toUpperCase();
  };
  const oversToBalls = o => { const [a, b] = String(o).split('.'); return (Number(a) || 0) * 6 + (Number(b) || 0); };

  function parse(doc) {
    const teams = [...doc.querySelectorAll('.match-summary li.win')].map(li => {
      const name = clean(li.querySelector('.teamName')?.textContent);
      const score = clean([...li.querySelectorAll('span')].find(s => !s.classList.contains('teamName'))?.textContent);
      const overs = clean(li.querySelector('p')?.textContent).split('/')[0].trim();
      return { name, score, overs, code: teamCode(name) };
    });

    // Title looks like "DD 42/7 (8.4/14 ov) - League"; use it to find the batting side and its short code.
    const tm = clean(doc.title).match(/^(\S+)\s+(\d+\/\d+)/);
    let batIdx = tm ? teams.findIndex(t => t.score === tm[2]) : -1;
    if (batIdx < 0) batIdx = teams.length > 1 && teams[1].score !== '0/0' ? 1 : 0;
    if (tm && teams[batIdx]) teams[batIdx].code = tm[1];

    const tableByHead = head => [...doc.querySelectorAll('table')]
      .find(t => t.rows[0] && clean(t.rows[0].cells[0]?.textContent) === head);
    const rowsOf = t => t ? [...t.rows].slice(1).map(r => [...r.cells].map(c => clean(c.textContent))).filter(c => c[0]) : [];

    const batters = rowsOf(tableByHead('Batter')).slice(0, 2).map(c => ({ name: c[0], r: c[1], b: c[2] }));
    const bowler = rowsOf(tableByHead('Bowler')).slice(0, 1).map(c => ({ name: c[0], o: c[1], r: c[3], w: c[4] }))[0];

    // Ball-by-ball rows, newest first: "8.4 | Muhammad A to Balaji B, 0 run"
    let balls = [], last = null;
    const section = doc.querySelector('.ball-by-ball-section');
    if (section) {
      const all = [...section.querySelectorAll('ul.bbb-row')].map(u => {
        const col = u.querySelector('li.col2');
        const ov = clean(col?.querySelector('.ov')?.textContent);
        if (!ov) return null;
        const mark = [...col.querySelectorAll('span')].find(s => !s.classList.contains('ov'));
        let v = clean(mark?.textContent);
        if (!v && mark) v = [...mark.classList].map(c => BALL_CLASS[c]).find(Boolean) || '';
        const m = clean(u.querySelector('li.col3')?.textContent).match(/ to (.+?)(?=,| OUT!| WIDE| NO ?BALL| LEG ?BYES?| BYES?|$)/i);
        return { ov, v: v || '•', faced: m ? m[1] : '' };
      }).filter(Boolean);
      if (all.length) {
        last = all[0];
        const over = last.ov.split('.')[0];
        balls = all.filter(b => b.ov.split('.')[0] === over).reverse();
      }
    }

    // Striker: the batter named in the latest ball ("Bowler to Balaji B, ...").
    let striker = -1;
    if (last && batters.length === 2) {
      const faced = shortName(last.faced);
      striker = batters.findIndex(b => shortName(b.name) === faced);
      if (striker < 0) {
        const first = faced.split(' ')[0];
        striker = batters.findIndex(b => shortName(b.name).split(' ')[0] === first);
      }
      // Latest ball was a wicket: the batter who faced it is gone, so the new batter is on strike.
      if (striker < 0) striker = Number(batters[1].b) < Number(batters[0].b) ? 1 : 0;
    }

    const info = clean(doc.querySelector('.score-top h3')?.textContent);
    return { teams, batIdx, batters, bowler, balls, striker, info };
  }

  // Bridge mode: this page is embedded (iframe) or opened (popup) by the hosted overlay page.
  // Send it the parsed score now and after every poll; the hosted page does the drawing.
  if (BRIDGE) {
    const target = window.parent !== window ? window.parent : window.opener;
    const send = msg => target && target.postMessage(Object.assign({ source: 'cc-overlay' }, msg), '*');
    const src = location.href.split('#')[0];
    send({ data: parse(document) });
    document.body.innerHTML = '<p style="font:14px sans-serif">CricClubs overlay feed running. Keep this open.</p>';
    setInterval(async () => {
      try {
        const res = await fetch(src, { credentials: 'include', cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        if (!doc.querySelector('.match-summary')) throw new Error('no scorecard in response');
        send({ data: parse(doc) });
      } catch (e) {
        send({ error: e.message });
      }
    }, REFRESH_MS);
    return;
  }

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function render(d) {
    const bat = d.teams[d.batIdx] || {};
    const other = d.teams[1 - d.batIdx] || {};
    const secondInnings = other.score && other.score !== '0/0';
    const [runs, wkts] = (bat.score || '0/0').split('/');
    const ballsBowled = oversToBalls(bat.overs);
    const rr = ballsBowled ? (Number(runs) / (ballsBowled / 6)).toFixed(2) : '0.00';

    const batterCell = (b, i) => b ? `<span class="bt${i === d.striker ? ' on' : ''}">
        ${i === d.striker ? '<i class="bat"></i>' : ''}${esc(shortName(b.name))}
        <b>${esc(b.r)}</b><small>${esc(b.b)}</small></span>` : '<span></span>';
    const ballCls = v => /W/i.test(v) ? 'w' : v === '4' ? 'f' : v === '6' ? 's' : /wd|nb|lb|b/i.test(v) ? 'x' : '';
    // In the chase, show CricClubs' "need ..." line; otherwise the fixture.
    const fixture = secondInnings && /need|target|require/i.test(d.info)
      ? esc(d.info)
      : `${esc((bat.name || '').toUpperCase())} <em>vs</em> ${esc((other.name || '').toUpperCase())}`;

    root.innerHTML = `
      <div class="panel left">
        <div class="row top">${batterCell(d.batters[d.striker === 1 ? 1 : 0], d.striker === 1 ? 1 : 0)}${batterCell(d.batters[d.striker === 1 ? 0 : 1], d.striker === 1 ? 0 : 1)}</div>
        <div class="row bottom fixture">${fixture}</div>
      </div>
      <div class="team-box">
        <div class="codes">${esc(bat.code)}<em>v ${esc(other.code)}</em></div>
        <div class="big">${esc(runs)}<em>/${esc(wkts)}</em></div>
      </div>
      <div class="rate-box">
        <div class="rr">RR <b>${rr}</b></div>
        <div class="ov">OVERS <b>${esc(bat.overs)}</b></div>
      </div>
      <div class="panel right">
        <div class="row top">${d.bowler ? `<span class="bw">${esc(shortName(d.bowler.name))}
          <b>${esc(d.bowler.r)}/${esc(d.bowler.w)}</b><small>${esc(d.bowler.o)}</small></span>` : ''}</div>
        <div class="row bottom balls">${d.balls.map(b => `<span class="${ballCls(b.v)}">${esc(b.v === '0' ? '•' : b.v)}</span>`).join('')}</div>
      </div>`;
  }

  // Read the score from the page as loaded, then replace the page with the overlay.
  const initial = parse(document);
  document.head.innerHTML = `<meta charset="utf-8"><title>Score overlay</title><style>
    @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&display=swap');
    html,body{margin:0;background:${BG}}
    #ov{display:inline-flex;align-items:center;margin:20px;zoom:${SCALE};
      font-family:"Barlow Condensed","Arial Narrow",Arial,sans-serif;text-transform:uppercase;letter-spacing:.3px}
    em{font-style:normal}
    .panel{background:linear-gradient(#fbfbfc,#e4e7ec);height:100px;display:flex;flex-direction:column;
      box-shadow:0 2px 6px rgba(0,0,0,.35)}
    .panel.left{width:430px;border-radius:4px 0 0 4px}
    .panel.right{width:430px;border-radius:0 4px 4px 0}
    .row{flex:1;display:flex;align-items:center;padding:0 18px;color:#1c2a5a;font-size:22px;font-weight:600}
    .row.top{border-bottom:1px solid #c9ced8;justify-content:space-between}
    .row b{color:#1f6fd1;font-weight:700;margin-left:8px;font-size:24px}
    .row small{color:#2b8fd6;font-size:16px;font-weight:600;margin-left:5px}
    .bt{display:flex;align-items:baseline}
    .bat{display:inline-block;width:5px;height:20px;background:#f07a1a;border-radius:2px;transform:rotate(25deg);
      margin-right:10px;align-self:center}
    .fixture{justify-content:center;font-size:19px;color:#2a3550}
    .fixture em{color:#2b8fd6;font-size:14px;margin:0 8px}
    .team-box{background:linear-gradient(#1747d6,#0b2a9a);color:#fff;width:200px;height:128px;display:flex;
      flex-direction:column;justify-content:center;padding:0 18px;box-sizing:border-box;z-index:1;
      box-shadow:0 2px 8px rgba(0,0,0,.5)}
    .codes{font-size:36px;font-weight:700;line-height:1;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.35)}
    .codes em{font-size:22px;color:#f5b922;margin-left:8px;font-weight:600}
    .big{font-size:64px;font-weight:700;line-height:1;padding-top:6px}
    .big em{color:#f5b922;font-size:44px}
    .rate-box{width:190px;height:128px;display:flex;flex-direction:column;z-index:1;box-shadow:0 2px 8px rgba(0,0,0,.5)}
    .rate-box>div{flex:1;display:flex;align-items:center;justify-content:center;color:#fff;font-size:28px;font-weight:600}
    .rate-box b{font-size:34px;margin-left:10px;font-weight:700}
    .rr{background:linear-gradient(#2a6fe8,#1a52c4)}
    .ov{background:linear-gradient(#f0303a,#c8141e)}
    .balls{gap:8px}
    .balls span{min-width:26px;height:26px;line-height:26px;border-radius:13px;background:#fff;border:1px solid #c9ced8;
      color:#1c2a5a;text-align:center;font-size:15px;font-weight:700;padding:0 3px;box-sizing:border-box}
    .balls .w{background:#e8202a;border-color:#e8202a;color:#fff}
    .balls .f{background:#1f6fd1;border-color:#1f6fd1;color:#fff}
    .balls .s{background:#7a3fc4;border-color:#7a3fc4;color:#fff}
    .balls .x{background:#fff4d6;border-color:#f5b922}
    .stale .big{opacity:.5}
  </style>`;
  document.body.innerHTML = '<div id="ov"></div>';
  document.body.removeAttribute('class');
  const root = document.getElementById('ov');

  // Poll the ball-by-ball page for the same match (same matchId/clubId query).
  const src = location.origin + location.pathname.replace(/[^/]+$/, 'ballbyball.do') + location.search;
  render(initial);

  async function tick() {
    try {
      const res = await fetch(src, { credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      if (!doc.querySelector('.match-summary')) throw new Error('no scorecard in response');
      render(parse(doc));
      root.classList.remove('stale');
    } catch (e) {
      // Keep the last good score on screen; dim it so a stall is visible.
      root.classList.add('stale');
      console.warn('[cc-overlay]', e.message);
    }
  }
  setInterval(tick, REFRESH_MS);
})();
