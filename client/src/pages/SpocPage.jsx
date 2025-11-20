// client/src/pages/SpocPage.jsx
import React, { useEffect, useRef, useState } from 'react';
import { SPOCS, TEAMS } from '../data/spocs'; // keep your static mapping here
import { socket } from '../socket';           // your socket wrapper
const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export default function SpocPage() {
  const [pin, setPin] = useState('');
  const [spoc, setSpoc] = useState(null);
  const [team, setTeam] = useState(null);
  const [requests, setRequests] = useState([]);
  const audioRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [notifEnabled, setNotifEnabled] = useState(false);

  // set up media and sockets once
  useEffect(() => {
    // use the mp4 placed in public/ (browsers can play mp4 audio)
    audioRef.current = new Audio('/notifications.mp4');

    const createdHandler = (doc) => {
      if (!doc) return;
      // if doc for this spoc/team, show and play
      // we will filter by teamId when fetching, but server pushes targeted events
      setRequests(prev => [doc, ...prev]);
      // attempt to play; if blocked, user will need to enable
      audioRef.current?.play().catch(() => {});
    };

    const updatedHandler = (doc) => setRequests(prev => prev.map(r => r._id === doc._id ? doc : r));
    const deletedHandler = (d) => setRequests(prev => prev.filter(r => r._id !== d._id));

    socket.on('request:created:forSpoc', createdHandler);
    socket.on('request:created:forTeam', createdHandler);
    socket.on('request:updated', updatedHandler);
    socket.on('request:deleted', deletedHandler);

    return () => {
      socket.off('request:created:forSpoc', createdHandler);
      socket.off('request:created:forTeam', createdHandler);
      socket.off('request:updated', updatedHandler);
      socket.off('request:deleted', deletedHandler);
    };
  }, []);

  // on mount: try auto-login using stored token
  useEffect(() => {
    (async () => {
      const token = sessionStorage.getItem('spocToken');
      if (!token) return;
      try {
        const res = await fetch(`${API}/api/spoc/validate`, {
          headers: { 'x-spoc-token': token }
        });
        if (!res.ok) {
          sessionStorage.removeItem('spocToken');
          return;
        }
        const j = await res.json();
        if (j.ok) {
          // if server returned spocId, use it; else try mapping from sess-storage or fallback
          const spocId = j.spocId || null;
          let foundSpoc = SPOCS.find(s => s.id === spocId);
          if (!foundSpoc && spocId) foundSpoc = { id: spocId, name: spocId };
          // set states
          setSpoc(foundSpoc || null);
          const t = TEAMS.find(tt => tt.spocId === (foundSpoc?.id || spocId));
          setTeam(t || null);
          // join rooms so socket receives targeted events
          if (spocId) socket.emit('spoc:join', spocId);
          if (t?.id) socket.emit('team:join', t.id);
          if (t?.id) fetchTeamRequests(t.id);
        } else {
          sessionStorage.removeItem('spocToken');
        }
      } catch (err) {
        console.error('auto-login validation failed', err);
      }
    })();
  }, []);

  async function fetchTeamRequests(teamId) {
    try {
      const res = await fetch(`${API}/api/requests`);
      const docs = await res.json();
      setRequests(docs.filter(d => d.teamId === teamId));
    } catch (err) { console.error('fetchTeamRequests', err); }
  }

  const handleUnlock = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/spoc/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const j = await res.json();
      if (!res.ok) {
        alert(j.error || 'Unlock failed');
        setLoading(false);
        return;
      }
      sessionStorage.setItem('spocToken', j.token);
      let spocId = j.spocId;
      if (!spocId) {
        const found = SPOCS.find(s => s.id === String(pin).trim());
        spocId = found?.id;
      }
      const foundSpoc = SPOCS.find(s => s.id === spocId);
      setSpoc(foundSpoc || { id: spocId, name: spocId || 'SPOC' });
      const t = TEAMS.find(tt => tt.spocId === spocId);
      setTeam(t || null);
      if (spocId) socket.emit('spoc:join', spocId);
      if (t?.id) {
        socket.emit('team:join', t.id);
        await fetchTeamRequests(t.id);
      }
      // Try to allow audio now — user clicked Unlock so play should be allowed
      try { audioRef.current?.play().then(()=>setNotifEnabled(true)).catch(()=>{}); } catch(e){}
    } catch (err) {
      console.error('handleUnlock err', err);
      alert('Unlock failed (network)');
    } finally {
      setLoading(false);
    }
  };

  // if play is blocked, user can click to enable notifications
  const enableNotifications = () => {
    try {
      audioRef.current = audioRef.current || new Audio('/notifications.mp4');
      audioRef.current.play().then(() => setNotifEnabled(true)).catch(() => {
        alert('Browser blocked autoplay — try clicking Unlock first or interact with the page.');
      });
    } catch (e) { console.error(e); alert('Cannot enable notifications'); }
  };

  const markDone = async (id) => {
    try {
      const token = sessionStorage.getItem('spocToken');
      const res = await fetch(`${API}/api/requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-spoc-token': token || '' },
        body: JSON.stringify({ status: 'done' })
      });
      if (!res.ok) {
        const j = await res.json();
        throw new Error(j.error || 'Update failed');
      }
      const updated = await res.json();
      setRequests(prev => prev.map(r => r._id === updated._id ? updated : r));
    } catch (err) { console.error('markDone err', err); alert('Update failed'); }
  };

  const removeReq = async (id) => {
    if (!confirm('Delete this request?')) return;
    try {
      const token = sessionStorage.getItem('spocToken');
      const res = await fetch(`${API}/api/requests/${id}`, {
        method: 'DELETE',
        headers: { 'x-spoc-token': token || '' }
      });
      if (res.status === 204) {
        setRequests(prev => prev.filter(r => r._id !== id));
        return;
      }
      const j = await res.json();
      throw new Error(j.error || 'Delete failed');
    } catch (err) { console.error('removeReq err', err); alert('Delete failed'); }
  };

  if (!spoc) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <form className="bg-white p-8 rounded shadow-md" onSubmit={handleUnlock}>
          <h2 className="text-xl mb-4">SPOC Login</h2>
          <p>Enter your SPOC id (example: spoc-1) or the shared PIN</p>
          <input value={pin} onChange={e => setPin(e.target.value)} className="border p-2 w-full my-2" />
          <div className="flex items-center gap-3">
            <button className="px-4 py-2 rounded bg-green-600 text-white" disabled={loading}>{loading ? 'Unlocking...' : 'Unlock'}</button>
            <button type="button" onClick={enableNotifications} className="px-4 py-2 rounded bg-gray-300">Enable notifications</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <div><strong>SPOC: {spoc.name}</strong> — Team: {team?.name || '—'}</div>
        <div>
          <button className="px-3 py-1 border rounded" onClick={() => {
            if (spoc?.id) socket.emit('spoc:leave', spoc.id);
            if (team?.id) socket.emit('team:leave', team.id);
            sessionStorage.removeItem('spocToken');
            setSpoc(null); setTeam(null); setRequests([]);
          }}>Logout</button>
        </div>
      </div>

      <ul className="bg-white p-4 rounded shadow">
        {requests.map(r => (
          <li key={r._id} className="border-b py-3 flex justify-between">
            <div>
              <div className="font-semibold">{r.requester || '—'} • {r.category}</div>
              <div className="text-sm text-gray-600">{r.location} • {r.quantity}</div>
              <div className="mt-1">{r.details}</div>
              <div className="text-xs text-gray-500 mt-1">{new Date(r.createdAt).toLocaleString()}</div>
            </div>

            <div className="flex flex-col gap-2 items-end">
              <div className={`px-2 py-1 rounded text-sm ${r.status === 'pending' ? 'bg-yellow-100' : 'bg-green-100'}`}>{r.status}</div>
              <div className="flex gap-2">
                <button className="bg-blue-500 text-white px-3 py-1 rounded text-sm" onClick={() => markDone(r._id)}>Mark Done</button>
                <button className="bg-red-500 text-white px-3 py-1 rounded text-sm" onClick={() => removeReq(r._id)}>Delete</button>
              </div>
            </div>
          </li>
        ))}
        {requests.length === 0 && <li className="py-4 text-center text-gray-500">No requests for your team.</li>}
      </ul>
    </div>
  );
}
