// client/src/pages/RequesterPage.jsx
import React, { useEffect, useState } from 'react';
import { TEAMS } from '../data/spocs';
import { socket } from '../socket';
const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export default function RequesterPage() {
  const [form, setForm] = useState({
    requester: '',
    category: 'Tea',
    details: '',
    location: '',
    quantity: '',
    teamId: TEAMS[0]?.id || ''
  });
  const [requests, setRequests] = useState([]);

  useEffect(() => {
    fetchRequests();

    const onCreated = (doc) => {
      setRequests(prev => [doc, ...prev]);
    };
    const onUpdated = (doc) => {
      setRequests(prev => prev.map(r => (r._id === doc._id ? doc : r)));
    };
    const onDeleted = (d) => {
      setRequests(prev => prev.filter(r => r._id !== d._id));
    };

    socket.on('request:created', onCreated);
    socket.on('request:updated', onUpdated);
    socket.on('request:deleted', onDeleted);

    if (form.teamId) socket.emit('team:join', form.teamId);

    return () => {
      socket.off('request:created', onCreated);
      socket.off('request:updated', onUpdated);
      socket.off('request:deleted', onDeleted);
      if (form.teamId) socket.emit('team:leave', form.teamId);
    };
  }, []);

  const fetchRequests = async () => {
    try {
      const res = await fetch(`${API}/api/requests`);
      const data = await res.json();
      setRequests(data);
    } catch (err) {
      console.error('fetchRequests err', err);
    }
  };

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const team = TEAMS.find(t => t.id === form.teamId);
      const body = { ...form, spocId: team?.spocId || null };
      const res = await fetch(`${API}/api/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const j = await res.json();
        alert(j.error || 'Failed to create request');
        return;
      }
      const created = await res.json();
      setForm({ requester: '', category: 'Tea', details: '', location: '', quantity: '', teamId: form.teamId });
      setRequests(prev => [created, ...prev]);
    } catch (err) {
      console.error('handleSubmit err', err);
      alert('Error creating request');
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold">Requester</h2>
      </div>

      <form onSubmit={handleSubmit} className="bg-white p-4 rounded shadow card-anim mb-4">
        <div className="mb-2">
          <label className="block font-semibold mb-1">Requester name</label>
          <input name="requester" value={form.requester} onChange={handleChange} className="border p-2 w-full rounded" />
        </div>

        <div className="mb-2">
          <label className="block font-semibold mb-1">Team</label>
          <select name="teamId" value={form.teamId} onChange={handleChange} className="border p-2 w-full rounded">
            {TEAMS.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>

        <div className="mb-2">
          <label className="block font-semibold mb-1">Category</label>
          <select name="category" value={form.category} onChange={handleChange} className="border p-2 w-full rounded">
            <option value="Tea">Tea</option>
            <option value="Coffee">Coffee</option>
            <option value="WiFi">WiFi</option>
            <option value="Other">Other</option>
          </select>
        </div>

        <div className="mb-2">
          <label className="block font-semibold mb-1">Location (required)</label>
          <input name="location" value={form.location} onChange={handleChange} required className="border p-2 w-full rounded" />
        </div>

        <div className="mb-2">
          <label className="block font-semibold mb-1">Quantity</label>
          <input name="quantity" value={form.quantity} onChange={handleChange} className="border p-2 w-full rounded" />
        </div>

        <div className="mb-2">
          <label className="block font-semibold mb-1">Details</label>
          <textarea name="details" value={form.details} onChange={handleChange} className="border p-2 w-full rounded" rows="3" />
        </div>

        <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition">Submit Request</button>
      </form>

      <h3 className="text-lg font-bold mb-2">Latest requests</h3>
      <ul className="bg-white p-4 rounded shadow">
        {requests.length === 0 && <li className="py-4 text-center text-gray-500">No requests yet.</li>}
        {requests.map(r => (
          <li key={r._id} className="border-b py-2 last:border-b-0">
            <div className="font-semibold">{r.requester || '—'} • {r.category}</div>
            <div className="text-sm text-gray-600">{r.location} • {r.quantity} • Team: {TEAMS.find(t => t.id === r.teamId)?.name || r.teamId}</div>
            <div className="mt-1">{r.details}</div>
            <div className="text-xs text-gray-500 mt-1">{new Date(r.createdAt).toLocaleString()}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}