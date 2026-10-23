import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowLeft, Check, Copy, Crown, Gamepad2, Link2, LoaderCircle, LogOut, Radio, RotateCcw, ShieldCheck, Sparkles, Swords, Users, Wifi, WifiOff, X as XIcon } from 'lucide-react'
import { isSupabaseConfigured, supabase } from './supabase'
import { cleanRoomCode, createRoomCode, EMPTY_BOARD, getOutcome } from './game'

const SESSION_KEY = 'ngd-player-id'
const NAME_KEY = 'ngd-player-name'
const getPlayerId = () => {
  let id = localStorage.getItem(SESSION_KEY)
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() || `p-${Date.now()}-${Math.random().toString(36).slice(2)}`
    localStorage.setItem(SESSION_KEY, id)
  }
  return id
}
const newLocalRoom = (code, playerId, name) => ({
  code, host_id: playerId, guest_id: null, host_name: name, guest_name: null,
  board: EMPTY_BOARD, current_turn: 'X', status: 'waiting', winner: null, winning_line: [],
  draws: 0, x_wins: 0, o_wins: 0, round: 1, rematch_x: false, rematch_o: false,
  updated_at: new Date().toISOString(),
})

export default function App() {
  const [playerId] = useState(getPlayerId)
  const [playerName, setPlayerName] = useState(() => localStorage.getItem(NAME_KEY) || '')
  const [nameDraft, setNameDraft] = useState(() => localStorage.getItem(NAME_KEY) || '')
  const [roomInput, setRoomInput] = useState('')
  const [room, setRoom] = useState(null)
  const [myMark, setMyMark] = useState(null)
  const [screen, setScreen] = useState('home')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [connected, setConnected] = useState(false)
  const [history, setHistory] = useState([])
  const [localMode, setLocalMode] = useState(!isSupabaseConfigured)
  const channelRef = useRef(null)
  const pollRef = useRef(null)
  const myMarkRef = useRef(myMark)
  myMarkRef.current = myMark

  const notify = useCallback((message) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2600)
  }, [])

  useEffect(() => {
    if (playerName) localStorage.setItem(NAME_KEY, playerName)
  }, [playerName])

  const applyRoom = useCallback((next) => {
    if (!next) return
    setRoom(next)
    if (next.host_id === playerId) setMyMark('X')
    else if (next.guest_id === playerId) setMyMark('O')
    setHistory(Array.isArray(next.match_history) ? next.match_history : [])
  }, [playerId])

  const refreshRoom = useCallback(async (code) => {
    if (!supabase || !code) return
    const { data, error: fetchError } = await supabase.rpc('get_neon_room', { p_code: code })
    if (fetchError) throw fetchError
    if (data) applyRoom(data)
  }, [applyRoom])

  useEffect(() => {
    if (!room?.code || localMode || !supabase) return
    setConnected(false)
    const channel = supabase.channel(`room:${room.code}`, { config: { broadcast: { self: true } } })
      .on('broadcast', { event: 'room_update' }, () => {
        // Fetch through the room RPC after a lightweight room-scoped broadcast.
        refreshRoom(room.code).catch(() => {})
      })
      .subscribe(status => {
        setConnected(status === 'SUBSCRIBED')
        if (status === 'SUBSCRIBED') refreshRoom(room.code).catch(() => {})
      })
    channelRef.current = channel
    // Polling is a recovery path if a realtime event is missed.
    pollRef.current = window.setInterval(() => refreshRoom(room.code).catch(() => {}), 5000)
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
      supabase.removeChannel(channel)
      channelRef.current = null
    }
  }, [room?.code, localMode, applyRoom, refreshRoom])

  const ensureName = () => {
    const name = (nameDraft || playerName || 'Player').trim().slice(0, 18) || 'Player'
    setPlayerName(name)
    setNameDraft(name)
    localStorage.setItem(NAME_KEY, name)
    return name
  }

  const createRoom = async () => {
    const name = ensureName()
    setBusy(true); setError(''); setNotice('')
    try {
      if (isSupabaseConfigured && supabase) {
        const code = createRoomCode()
        const { data, error: rpcError } = await supabase.rpc('create_neon_room', {
          p_code: code, p_player_id: playerId, p_player_name: name,
        })
        if (rpcError) throw rpcError
        applyRoom(data)
        setLocalMode(false)
      } else {
        const code = createRoomCode()
        const next = newLocalRoom(code, playerId, name)
        applyRoom(next); setLocalMode(true)
      }
      setScreen('game')
    } catch (e) {
      setError(e.message || 'Could not create room. Check your Supabase setup.')
    } finally { setBusy(false) }
  }

  const joinRoom = async (event) => {
    event?.preventDefault()
    const name = ensureName()
    const code = cleanRoomCode(roomInput)
    if (code.length < 4) { setError('Enter a valid room code.'); return }
    setBusy(true); setError('')
    try {
      if (!isSupabaseConfigured || !supabase) {
        const raw = sessionStorage.getItem(`ngd-local-room:${code}`)
        if (!raw) throw new Error('Local preview cannot connect across devices. Configure Supabase to use real multiplayer.')
        const existing = JSON.parse(raw)
        if (existing.host_id === playerId) { applyRoom(existing); setMyMark('X') }
        else if (!existing.guest_id) {
          existing.guest_id = playerId; existing.guest_name = name; existing.status = 'playing'
          sessionStorage.setItem(`ngd-local-room:${code}`, JSON.stringify(existing))
          applyRoom(existing); setMyMark('O')
        } else if (existing.guest_id === playerId) { applyRoom(existing); setMyMark('O') }
        else throw new Error('That room is full.')
        setLocalMode(true)
      } else {
        const { data, error: rpcError } = await supabase.rpc('join_neon_room', {
          p_code: code, p_player_id: playerId, p_player_name: name,
        })
        if (rpcError) throw rpcError
        applyRoom(data); setLocalMode(false)
      }
      setScreen('game')
    } catch (e) {
      setError(e.message || 'Could not join room. Check the code and try again.')
    } finally { setBusy(false) }
  }

  const playCell = async (index) => {
    if (!room || room.status !== 'playing' || room.board[index] || room.current_turn !== myMark || !myMark) return
    setError('')
    try {
      if (localMode || !supabase) {
        // Local demo only; real two-device play requires configured Supabase.
        const board = [...room.board]; board[index] = myMark
        const outcome = getOutcome(board)
        const next = { ...room, board, current_turn: myMark === 'X' ? 'O' : 'X',
          status: outcome.status, winner: outcome.winner, winning_line: outcome.line,
          x_wins: room.x_wins + (outcome.winner === 'X' ? 1 : 0),
          o_wins: room.o_wins + (outcome.winner === 'O' ? 1 : 0),
          draws: room.draws + (outcome.draw ? 1 : 0), updated_at: new Date().toISOString() }
        setRoom(next)
        return
      }
      const { data, error: rpcError } = await supabase.rpc('play_neon_move', {
        p_code: room.code, p_player_id: playerId, p_cell: index,
      })
      if (rpcError) throw rpcError
      applyRoom(data)
    } catch (e) { setError(e.message || 'Move rejected. Please try again.') }
  }

  const requestRematch = async () => {
    if (!room) return
    setBusy(true); setError('')
    try {
      if (localMode || !supabase) {
        const flag = myMark === 'X' ? 'rematch_x' : 'rematch_o'
        const next = { ...room, [flag]: true }
        if (next.rematch_x && next.rematch_o) {
          Object.assign(next, { board: [...EMPTY_BOARD], current_turn: 'X', status: 'playing',
            winner: null, winning_line: [], round: room.round + 1, rematch_x: false, rematch_o: false })
        }
        setRoom(next)
      } else {
        const { data, error: rpcError } = await supabase.rpc('request_neon_rematch', {
          p_code: room.code, p_player_id: playerId,
        })
        if (rpcError) throw rpcError
        applyRoom(data)
      }
      notify('Rematch request sent')
    } catch (e) { setError(e.message || 'Could not request rematch.') }
    finally { setBusy(false) }
  }

  const leaveRoom = async () => {
    if (channelRef.current && supabase) await supabase.removeChannel(channelRef.current)
    setRoom(null); setMyMark(null); setScreen('home'); setError(''); setNotice('')
  }

  const copyInvite = async () => {
    const link = `${window.location.origin}/?room=${room.code}`
    try {
      await navigator.clipboard.writeText(`Join my Neon Grid Duel! Room code: ${room.code}\n${link}`)
      setCopied(true); notify('Invite copied to clipboard')
      window.setTimeout(() => setCopied(false), 1800)
    } catch { setRoomInput(room.code); notify(`Room code: ${room.code}`) }
  }

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('room')
    if (code) setRoomInput(cleanRoomCode(code))
  }, [])

  const outcome = useMemo(() => room ? getOutcome(room.board || EMPTY_BOARD) : null, [room?.board])
  const winner = room?.winner || outcome?.winner
  const isDraw = room?.status === 'finished' && !winner && (room?.board || []).every(Boolean)
  const rematchRequested = myMark === 'X' ? room?.rematch_x : room?.rematch_o
  const opponentRequested = myMark === 'X' ? room?.rematch_o : room?.rematch_x
  const canMove = room?.status === 'playing' && room?.current_turn === myMark && room?.guest_id
  const playerX = room?.host_name || 'Player X'
  const playerO = room?.guest_name || 'Waiting…'

  return (
    <main className="app-shell">
      <div className="ambient ambient-cyan" /><div className="ambient ambient-pink" />
      <header className="topbar">
        <button className="brand" onClick={leaveRoom} aria-label="Neon Grid Duel home">
          <span className="brand-icon"><Gamepad2 size={22}/></span>
          <span>NEON<span className="brand-accent">GRID</span><small>DUEL PROTOCOL // 01</small></span>
        </button>
        <div className="topbar-right"><span className="live-pill"><span className="live-dot"/>{isSupabaseConfigured ? 'ONLINE SYSTEM' : 'PREVIEW MODE'}</span><span className="version">v1.0</span></div>
      </header>

      {screen === 'home' ? (
        <section className="home-layout">
          <div className="hero-copy">
            <div className="eyebrow"><Sparkles size={14}/> TWO PLAYERS. ONE GRID. NO MERCY.</div>
            <h1>ENTER THE<br/><span className="gradient-text">NEON GRID.</span></h1>
            <p className="hero-description">A head-to-head battle of logic and timing. Invite a rival, claim the grid, and make your move.</p>
            <div className="feature-row"><span><Radio size={15}/> REAL-TIME DUELS</span><span><ShieldCheck size={15}/> FAIR PLAY</span></div>
            {!isSupabaseConfigured && <div className="setup-warning"><WifiOff size={17}/><div><strong>Backend setup required</strong><p>This build is ready to connect. Add your Supabase URL and publishable key, then run the included SQL migration for cross-device multiplayer.</p></div></div>}
          </div>
          <div className="lobby-card">
            <div className="card-topline"><span>PLAYER TERMINAL</span><span className="terminal-status"><span/> READY</span></div>
            <label className="field-label" htmlFor="playerName">CALLSIGN</label>
            <input id="playerName" className="text-input" value={nameDraft} maxLength={18} onChange={e => setNameDraft(e.target.value)} placeholder="Enter your player name" />
            <button className="primary-button" onClick={createRoom} disabled={busy}><Swords size={18}/>{busy ? 'CREATING ROOM…' : 'CREATE NEW ROOM'}<span className="button-arrow">↗</span></button>
            <div className="or-divider"><span/> OR JOIN A DUEL <span/></div>
            <form onSubmit={joinRoom}>
              <label className="field-label" htmlFor="roomCode">ROOM ACCESS CODE</label>
              <div className="join-row"><input id="roomCode" className="text-input code-input" value={roomInput} onChange={e => setRoomInput(cleanRoomCode(e.target.value))} placeholder="E.G. 7K2P9M" maxLength={8} autoCapitalize="characters"/><button className="join-button" type="submit" disabled={busy || roomInput.length < 4}>{busy ? <LoaderCircle className="spin" size={18}/> : <ArrowLeft className="join-arrow" size={18}/>} JOIN</button></div>
            </form>
            {error && <p className="error-message">{error}</p>}
            <div className="lobby-footer"><span><Users size={15}/> 2 PLAYER MAX</span><span><Activity size={15}/> BEST OF YOUR WITS</span></div>
          </div>
          <div className="hero-grid-art" aria-hidden="true"><div className="art-grid">{Array.from({length:9}, (_, i) => <div className={`art-cell art-${i}`} key={i}>{[0,4,8].includes(i) ? <span className="art-x">×</span> : [2,6].includes(i) ? <span className="art-o">○</span> : <span className="art-dot"/>}</div>)}</div><div className="art-caption">FIG. 01 — THE BATTLEFIELD</div></div>
          <div className="bottom-note"><span>NEON GRID DUEL</span><span>DESIGNED FOR THE NEXT MOVE.</span><span>© 2026 // ONLINE ARCADE</span></div>
        </section>
      ) : (
        <section className="game-layout">
          <div className="game-heading">
            <button className="back-button" onClick={leaveRoom}><ArrowLeft size={16}/> LOBBY</button>
            <div><div className="eyebrow centered"><span className="live-dot"/> LIVE MATCH // ROUND {room?.round || 1}</div><h2>THE GRID IS <span className="gradient-text">YOURS.</span></h2></div>
            <div className={`connection ${connected || localMode ? 'connected' : ''}`}>{connected || localMode ? <Wifi size={15}/> : <WifiOff size={15}/>} {localMode ? 'LOCAL PREVIEW' : connected ? 'SYNCED' : 'CONNECTING'}</div>
          </div>
          <div className="room-strip"><div><span className="muted-label">ROOM CODE</span><strong>{room?.code}</strong></div><button onClick={copyInvite} className="copy-button">{copied ? <Check size={16}/> : <Copy size={16}/>} {copied ? 'COPIED' : 'COPY INVITE'}</button></div>
          <div className="match-grid">
            <div className={`player-card player-x ${myMark === 'X' ? 'self' : ''} ${room?.current_turn === 'X' && room?.status === 'playing' ? 'active-turn' : ''}`}><div className="player-card-top"><span className="player-symbol x-symbol">X</span>{room?.current_turn === 'X' && room?.status === 'playing' && <span className="turn-chip">YOUR MOVE{myMark !== 'X' ? ' — OPPONENT' : ''}</span>}</div><strong>{playerX}</strong><span className="player-role">{myMark === 'X' ? 'YOU // PLAYER 01' : 'PLAYER 01'}</span><div className="player-score"><span>WINS</span><b>{room?.x_wins || 0}</b></div></div>
            <div className="versus"><Swords size={19}/><span>VS</span></div>
            <div className={`player-card player-o ${myMark === 'O' ? 'self' : ''} ${room?.current_turn === 'O' && room?.status === 'playing' ? 'active-turn' : ''}`}><div className="player-card-top"><span className="player-symbol o-symbol">O</span>{room?.current_turn === 'O' && room?.status === 'playing' && <span className="turn-chip">YOUR MOVE{myMark !== 'O' ? ' — OPPONENT' : ''}</span>}</div><strong>{playerO}</strong><span className="player-role">{myMark === 'O' ? 'YOU // PLAYER 02' : room?.guest_id ? 'PLAYER 02' : 'AWAITING RIVAL'}</span><div className="player-score"><span>WINS</span><b>{room?.o_wins || 0}</b></div></div>
          </div>
          <div className="board-wrap">
            <div className="board-status">{room?.status === 'waiting' ? <><span className="pulse-dot"/> WAITING FOR OPPONENT TO JOIN</> : room?.status === 'finished' ? winner ? <><Crown size={16}/> {winner === myMark ? 'VICTORY — YOU WON' : `PLAYER ${winner} WINS`}</> : 'DRAW — GRID LOCKED' : <><span className="pulse-dot"/> {canMove ? 'YOUR TURN — MAKE IT COUNT' : `PLAYER ${room?.current_turn} IS THINKING`}</>}</div>
            <div className="game-board" role="grid" aria-label="Tic Tac Toe game board">
              {(room?.board || EMPTY_BOARD).map((cell, index) => <button key={index} role="gridcell" aria-label={`Cell ${index + 1}${cell ? `, ${cell}` : ', empty'}`} className={`board-cell ${cell === 'X' ? 'cell-x' : cell === 'O' ? 'cell-o' : ''} ${(room?.winning_line || []).includes(index) ? 'winning-cell' : ''}`} onClick={() => playCell(index)} disabled={!canMove || Boolean(cell) || room?.status !== 'playing'}>{cell && <span>{cell}</span>}</button>)}
            </div>
            {room?.status === 'finished' ? <div className="result-panel"><div className="result-icon">{winner ? <Crown size={22}/> : <Sparkles size={22}/>}</div><div><strong>{winner ? `${winner === myMark ? 'YOU WIN' : `${winner} TAKES THE ROUND`}` : 'IT’S A DRAW'}</strong><p>{opponentRequested ? 'Your rival wants a rematch. Accept to restart.' : rematchRequested ? 'Waiting for your rival to accept…' : 'Ready for another round?'}</p></div><button className="primary-button rematch-button" onClick={requestRematch} disabled={busy || rematchRequested}>{busy ? <LoaderCircle className="spin" size={17}/> : <RotateCcw size={17}/>} {rematchRequested ? 'REQUEST SENT' : 'REMATCH'}</button></div> : room?.status === 'waiting' ? <div className="waiting-panel"><div className="waiting-orb"><Users size={22}/></div><div><strong>YOUR RIVAL IS OUT THERE</strong><p>Share the room code or invite link. The duel starts when they join.</p></div><button className="secondary-button" onClick={copyInvite}><Link2 size={16}/> INVITE</button></div> : <div className="turn-footer"><span><span className={`mini-symbol ${room?.current_turn === 'X' ? 'x-symbol' : 'o-symbol'}`}>{room?.current_turn}</span> {canMove ? 'YOUR TURN' : 'OPPONENT’S TURN'}</span><span><ShieldCheck size={14}/> MOVES VALIDATED BY SERVER</span></div>}
            {error && <p className="error-message centered-error">{error}</p>}
          </div>
          <div className="game-bottom"><span><Radio size={14}/> REAL-TIME MULTIPLAYER</span><span>ROOM {room?.code} // ROUND {room?.round || 1}</span><button onClick={leaveRoom}><LogOut size={14}/> LEAVE MATCH</button></div>
        </section>
      )}
      {notice && <div className="toast"><Check size={16}/>{notice}</div>}
      <footer className="site-footer"><span>POWERED BY LOGIC. LIT BY NEON.</span><span>NEON GRID DUEL // HANDSHAKE CHALLENGE</span></footer>
    </main>
  )
}
