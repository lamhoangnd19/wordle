import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, ArrowRight, Trophy, Flame, X, HelpCircle, BarChart3, Delete, Check, Copy, Users, Sparkles, Clock, Target, SkipForward, Bell, ThumbsUp, ThumbsDown } from 'lucide-react';
import './style.css';

function App() {
  const [data, setData] = useState(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState('play');
  const [shake, setShake] = useState(false);
  const [clock, setClock] = useState('10:00');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const api = useCallback(async (body) => {
    const response = await fetch('/api/game', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Không thể kết nối. Hãy thử lại.');
    setData(result); return result;
  }, []);
  useEffect(() => { api().catch(e=>setError(e.message)); }, [api]);
  useEffect(() => {
    const interval = setInterval(() => { if (!pending.current && document.visibilityState === 'visible') api().catch(()=>{}); }, 5000);
    return () => clearInterval(interval);
  }, [api]);
  useEffect(() => {
    if (!data?.round) return;
    const offset = new Date(data.serverTime).getTime() - Date.now();
    let refreshing = false;
    const tick = async () => {
      const remaining = Math.max(0, new Date(data.round.endsAt).getTime() - (Date.now() + offset));
      const seconds = Math.ceil(remaining / 1000);
      setClock(`${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`);
      if (remaining <= 0 && !refreshing && !pending.current) {
        refreshing = true;
        try { await api(); } catch (e) { setError(e.message); }
      }
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [api, data?.round?.id, data?.round?.endsAt, data?.serverTime]);
  const perform = async body => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const previousRound = data?.round?.id;
      const result = await api(body);
      if (body.action === 'guess' || body.action === 'start') setInput('');
      if (body.action === 'join') setModal(null);
      if (body.action === 'proposeSkip' || body.action === 'voteSkip') {
        if (result.round.id !== previousRound) setNotice('Tất cả đã đồng ý. Phiên mới đã bắt đầu!');
        else if (body.action === 'voteSkip' && body.accept === false) setNotice('Bạn đã từ chối. Đề xuất bỏ qua đã kết thúc.');
        else setNotice('Đã ghi nhận. Đang chờ những người chơi online còn lại.');
      }
      return result;
    } catch(e) { setError(e.message); setShake(true); setTimeout(()=>setShake(false),450); }
    finally { setBusy(false); pending.current = false; }
  };
  const player = data?.player;
  const game = data?.game;
  const skipVote = data?.skipVote;
  const rows = game?.guesses || [];
  const active = game?.status === 'playing';
  const begin = () => setModal('join');
  useEffect(() => { setInput(''); setError(''); }, [game?.id]);
  const keypress = useCallback(key => {
    if (busy || modal || !active) return;
    if (key === 'ENTER') { perform({action:'guess', gameId:game.id, guess:input}); }
    else if (key === 'BACKSPACE') { setInput(s=>s.slice(0,-1)); setError(''); }
    else if (/^[A-Z]$/.test(key)) { setInput(s=>s.length<5?s+key:s); setError(''); }
  }, [busy, modal, active, game?.id, input]);
  useEffect(()=> {
    const listener = e => {
      if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
      if (/^[a-z]$/i.test(e.key) || ['Enter','Backspace'].includes(e.key)) { e.preventDefault(); keypress(e.key.toUpperCase()); }
    };
    window.addEventListener('keydown',listener); return ()=>window.removeEventListener('keydown',listener);
  },[keypress]);
  useEffect(()=>{
    if (!modal) return;
    const previous = document.activeElement;
    const dialog = document.querySelector('.modal');
    dialog?.querySelector('input,button')?.focus();
    const trap = e => {
      if (e.key==='Escape') setModal(null);
      if (e.key==='Tab') {
        const elements = [...dialog.querySelectorAll('button,input,a')].filter(el=>!el.disabled);
        const first=elements[0], last=elements.at(-1);
        if (e.shiftKey && document.activeElement===first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement===last) {e.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',trap);
    return ()=>{document.removeEventListener('keydown',trap);previous?.focus();};
  },[modal]);
  const keys = {};
  const weights = {absent:1,present:2,correct:3};
  rows.forEach(row=>[...row.word].forEach((c,i)=>{if((weights[row.colors[i]]||0)>(weights[keys[c]]||0))keys[c]=row.colors[i];}));
  const copy = async result => {
    const text = result ? `Wordle Club ${game.status==='won'?rows.length:'X'}/6\n${rows.map(row=>row.colors.map(c=>({correct:'🟩',present:'🟨',absent:'⬜'}[c])).join('')).join('\n')}\n${window.location.origin}` : `Cùng mình leo rank Wordle Club!\n${window.location.origin}`;
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(()=>setCopied(false),2500); }
    catch { setError('Không thể sao chép tự động. Hãy sao chép đường dẫn trên thanh địa chỉ.'); }
  };
  const rankings = data?.leaderboard || [];
  return <>
    <header className="header"><a className="brand" href="/" aria-label="Wordle Club trang chủ"><span className="brand-icon">w<span>•</span></span>wordle<span className="brand-light">club</span><span className="beta">PLAY TOGETHER</span></a><nav><button className={tab==='play'?'nav-active':''} onClick={()=>setTab('play')}>Chơi Wordle</button><button className={tab==='rank'?'nav-active':''} onClick={()=>setTab('rank')}>Bảng xếp hạng <ArrowUpRight size={14}/></button></nav><button className="profile-button" onClick={()=>setModal(player?'stats':'join')}>{player?<><span className="avatar">{player.name[0].toUpperCase()}</span><span>{player.name}</span></>:<><Users size={16}/>Tham gia Club</>}</button></header>
    <main>
      <section className="intro"><div><div className="eyebrow"><span className="live-dot"/> MỌI NGƯỜI CÙNG MỘT TỪ · 10 PHÚT</div><h1>Cùng một từ.<br className="mobile-break"/> Cùng một cuộc đua<span>.</span></h1><p>5 chữ cái, 6 cơ hội. Giải cùng một từ trước khi đồng hồ về 0 và cùng bạn bè leo rank.</p></div><button className="invite" onClick={()=>copy(false)}>{copied?<Check size={17}/>:<Users size={17}/>} {copied?'Đã sao chép':'Rủ bạn bè'}<ArrowUpRight size={16}/></button></section>
      <div className={`workspace ${tab==='rank'?'rank-view':''}`}>
        <section className="game-card"><div className="game-heading"><div><span className="section-label">SÂN CHƠI CỦA BẠN</span><h2>Wordle phiên chung <span className="pill">EN</span></h2></div><div className="game-tools"><div className="round-timer" aria-label={`Từ mới sau ${clock}`}><Clock size={18}/><span><small>TỪ MỚI SAU</small><strong>{clock}</strong></span></div><button title="Thống kê của bạn" aria-label="Thống kê của bạn" onClick={()=>setModal('stats')}><BarChart3 size={19}/></button><button title="Cách chơi" aria-label="Cách chơi" onClick={()=>setModal('help')}><HelpCircle size={19}/></button></div></div>
        <div className="game-meta"><span><span className={`status-dot ${active?'green':''}`}/>{active?'Đang chơi':game?'Ván chơi đã kết thúc':'Sẵn sàng cho thử thách?'}</span><span>{rows.length}<span className="muted"> / 6 lượt thử</span></span></div>
        <div className={`board ${shake?'shake':''}`} role="group" aria-label="Bảng đoán từ 6 hàng 5 cột">{Array.from({length:6},(_,r)=><div className="board-row" key={`${game?.id}-${r}`}>{Array.from({length:5},(_,c)=>{
          const row=rows[r]; const letter=row?row.word[c]:r===rows.length&&active?input[c]:'';
          return <div key={c} className={`tile ${row?row.colors[c]:letter?'filled':''}`} style={{'--delay':`${c*65}ms`}} aria-label={row?`${letter}: ${{correct:'đúng vị trí',present:'sai vị trí',absent:'không có'}[row.colors[c]]}`:letter||'ô trống'}>{letter}</div>;
        })}</div>)}</div>
        <div className="message" aria-live="polite">{error?<span className="error">{error}</span>:busy?'Đang xử lý…':game?.status==='won'?<span className="success">Chính xác! +1 điểm · Chờ phiên mới sau {clock} 🎉</span>:game?.status==='lost'?<>Đáp án là <strong>{game.answer.toUpperCase()}</strong>. Phiên mới bắt đầu sau {clock}.</>:active?'Cùng một đáp án cho tất cả người chơi trong phiên này.':data&&!player?'Tham gia Club để bắt đầu đoán từ chung.':'Đang kết nối đến Club…'}</div>
        {player&&<div className="skip-zone" aria-live="polite">{skipVote?<div className="skip-vote"><Bell size={18}/><div className="skip-copy"><strong>{skipVote.proposedByName} đề xuất bỏ qua phiên</strong><span>{skipVote.accepted}/{skipVote.total} người đã đồng ý{skipVote.isEligible?' · Phiếu của bạn được tính trong đề xuất này':' · Bạn vào sau khi biểu quyết bắt đầu'}</span></div>{skipVote.isEligible&&!skipVote.hasVoted?<div className="vote-buttons"><button className="vote-yes" disabled={busy} onClick={()=>perform({action:'voteSkip',voteId:skipVote.id,accept:true})}><ThumbsUp size={15}/>Đồng ý</button><button className="vote-no" disabled={busy} onClick={()=>perform({action:'voteSkip',voteId:skipVote.id,accept:false})}><ThumbsDown size={15}/>Không</button></div>:<span className="vote-waiting">{skipVote.hasVoted?'Đã đồng ý':'Đang chờ'}</span>}</div>:<button className="skip-button" disabled={busy} onClick={()=>perform({action:'proposeSkip'})}><SkipForward size={16}/>Đề xuất bỏ qua phiên</button>}{notice&&<span className="skip-notice">{notice}</span>}</div>}
        {!active && <div className="game-actions">{!player?<button className="primary" disabled={busy||!data} onClick={begin}><Sparkles size={16}/>Tham gia phiên này<ArrowRight size={16}/></button>:<button className="primary" disabled><Clock size={16}/>Phiên mới sau {clock}</button>}{game&&<button className="secondary" onClick={()=>copy(true)}>{copied?<Check size={16}/>:<Copy size={16}/>}Chia sẻ</button>}{!data&&error&&<button className="secondary" onClick={()=>{setError('');api().catch(e=>setError(e.message));}}>Kết nối lại</button>}</div>}
        <div className="keyboard" aria-label="Bàn phím">{['QWERTYUIOP','ASDFGHJKL','ZXCVBNM'].map((row,i)=><div className="keyboard-row" key={row}>{i===2&&<button className="wide-key" disabled={!active||busy} onClick={()=>keypress('ENTER')}>ENTER</button>}{[...row].map(k=><button key={k} className={keys[k.toLowerCase()]||''} disabled={!active||busy} onClick={()=>keypress(k)} aria-label={`${k}${keys[k.toLowerCase()]?`, ${keys[k.toLowerCase()]}`:''}`}>{k}</button>)}{i===2&&<button className="wide-key" aria-label="Xóa chữ" disabled={!active||busy} onClick={()=>keypress('BACKSPACE')}><Delete size={20}/></button>}</div>)}</div>
        <div className="game-bottom"><span><span className="tiny-square correct"/> Đúng vị trí</span><span><span className="tiny-square present"/> Sai vị trí</span><span><span className="tiny-square absent"/> Không có</span></div></section>
        <aside><section className="rank-card"><div className="rank-heading"><div className="trophy-icon"><Trophy size={21}/></div><div><span className="section-label">CÙNG NHAU LEO RANK</span><h2>Bảng xếp hạng</h2></div><span className="live-label"><span className="live-dot"/>LIVE</span></div><p className="rank-description">Mỗi phiên giải đúng. Một điểm tiến lên.</p><div className="rank-table-header"><span>NGƯỜI CHƠI</span><span>ĐIỂM</span></div><div className="rank-list">{rankings.length?rankings.slice(0,tab==='rank'?50:7).map((p,i)=><div className={`rank-row ${p.id===player?.id?'is-you':''}`} key={p.id}><span className={`rank-number rank-${i+1}`}>{i===0?<Trophy size={15}/>:p.rank}</span><span className={`rank-avatar tone-${i%4}`}>{p.name[0].toUpperCase()}</span><div className="rank-name">{p.name}{p.id===player?.id&&<span className="you-tag">Bạn</span>}<small>{p.streak>0?<><Flame size={11}/> Chuỗi {p.streak} ván thắng</>:'Tiếp tục chinh phục'}</small></div><strong>{p.wins}<small>điểm</small></strong></div>):<div className="empty-ranking"><Trophy size={30}/><h3>Ngôi đầu đang chờ bạn</h3><p>Hoàn thành ván đầu tiên để ghi tên lên bảng xếp hạng.</p></div>}</div><div className="your-rank"><span className="avatar">{player?player.name[0].toUpperCase():'?'}</span><div><strong>{player?`Hạng của bạn: ${player.rank?'#'+player.rank:'chưa xếp hạng'}`:'Bạn sẽ ở vị trí nào?'}</strong><small>{player?`${player.wins} điểm · Tiếp tục nhé!`:'Tham gia và bắt đầu chinh phục'}</small></div>{!player&&<button onClick={()=>setModal('join')} aria-label="Tham gia"><ArrowRight size={18}/></button>}</div><div className="rank-footnote">Xếp theo tổng điểm · Đồng điểm xét lượt đoán TB</div></section>
        <section className="stats-card"><div className="stats-heading"><span>PHONG ĐỘ CỦA BẠN</span><Target size={16}/></div><div className="stats-grid"><div><strong>{player?.wins||0}</strong><span>Điểm</span></div><div><strong>{player?.played?Math.round(player.wins/player.played*100):0}<small>%</small></strong><span>Tỷ lệ thắng</span></div><div><strong>{player?.streak||0}<Flame size={18}/></strong><span>Chuỗi thắng</span></div></div></section>
        <section className="note-card"><span className="note-spark"><Sparkles size={20}/></span><div><h3>Mỗi phiên một thử thách chung.</h3><p>Tất cả cùng giải một từ trong 10 phút. Đồng hồ về 0, đáp án và bảng đoán tự động đổi cho mọi người.</p></div></section></aside>
      </div>
      <footer><span><span className="footer-mark">w.</span> Một chút suy nghĩ. Một chút niềm vui.</span><span>5 chữ cái <span className="footer-dot">·</span> 6 lượt thử <span className="footer-dot">·</span> Từ mới mỗi 10 phút</span></footer>
      {data?.storage==='demo'&&<p className="demo-note">Bản chạy thử cục bộ · Điểm được lưu trong bộ nhớ và sẽ mất khi khởi động lại máy chủ.</p>}
    </main>
    {modal&&<div className="modal-backdrop" onClick={()=>setModal(null)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={e=>e.stopPropagation()}><button className="close-button" aria-label="Đóng" onClick={()=>setModal(null)}><X size={20}/></button>{modal==='join'?<><div className="modal-icon"><Users size={26}/></div><span className="section-label">CHÀO MỪNG ĐẾN CLUB</span><h2 id="dialog-title">Tên của bạn trên bảng hạng?</h2><p>Chọn một biệt danh để bạn bè nhận ra bạn.</p><form onSubmit={e=>{e.preventDefault();perform({action:'join',name});}}><label htmlFor="nickname">Tên người chơi</label><input id="nickname" value={name} onChange={e=>setName(e.target.value)} minLength={2} maxLength={20} required placeholder="Ví dụ: Minh Anh" autoComplete="nickname"/><p className="form-note">2–20 ký tự. Hồ sơ được ghi nhớ trên trình duyệt này.</p>{error&&<p role="alert" className="error">{error}</p>}<button className="primary" disabled={busy}>{busy?'Đang tham gia…':'Tham gia & chơi ngay'}<ArrowRight size={17}/></button></form></>:modal==='help'?<><div className="modal-icon"><HelpCircle size={26}/></div><h2 id="dialog-title">5 chữ cái. 6 cơ hội.</h2><p>Mọi người cùng đoán một từ tiếng Anh trong phiên 10 phút, tối đa 6 lượt. Khi đồng hồ về 0, một từ chung mới sẽ tự động xuất hiện. Người chơi online cũng có thể nhất trí bỏ qua phiên hiện tại.</p><div className="help-example">{[...'PLANT'].map((c,i)=><span key={c} className={`tile ${i===0?'correct':i===2?'present':'absent'}`}>{c}</span>)}</div><ul className="help-list"><li><span className="tiny-square correct"/><div><strong>Xanh: đúng chữ, đúng vị trí.</strong></div></li><li><span className="tiny-square present"/><div><strong>Vàng: đúng chữ, sai vị trí.</strong></div></li><li><span className="tiny-square absent"/><div><strong>Xám: chữ này không còn trong đáp án.</strong></div></li></ul><p>Chữ lặp chỉ được tô màu theo số lần xuất hiện trong đáp án. Giải đúng trong phiên +1 điểm lên bảng xếp hạng. Đồng điểm: ít lượt đoán trung bình hơn xếp trên, rồi đến tên theo thứ tự chữ cái.</p><button className="primary" onClick={()=>setModal(null)}>Đã hiểu<Check size={17}/></button></>:<><div className="modal-icon"><BarChart3 size={26}/></div><h2 id="dialog-title">Phong độ của {player?.name||'bạn'}</h2><p>Mỗi ván là một cơ hội tiến bộ.</p><div className="modal-stats">{[['Ván đã chơi',player?.played||0],['Điểm',player?.wins||0],['Chuỗi hiện tại',player?.streak||0],['Chuỗi tốt nhất',player?.best||0]].map(([label,value])=><div key={label}><strong>{value}</strong><span>{label}</span></div>)}</div><button className="primary" onClick={()=>{setModal(null);if(!player)setModal('join');}}>{player?'Tiếp tục chơi':'Tham gia Club'}<ArrowRight size={17}/></button></>}</section></div>}
  </>;
}
createRoot(document.getElementById('root')).render(<App/>);
