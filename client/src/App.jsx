// client/src/App.jsx
import React from 'react'
import { Routes, Route, Link, Navigate } from 'react-router-dom'
import RequesterPage from './pages/RequesterPage'
import SpocPage from './pages/SpocPage'

export default function App() {
  return (
    <div className="min-h-screen bg-gray-100">

      {/* ---------- HEADER ---------- */}
       {/* inside App.jsx header area (replace header JSX) */}
      <header className="max-w-4xl mx-auto mb-6 flex justify-between items-center">
        {/* <div className="flex items-center gap-3">
          <img src="/logo-left.png" alt="logo-left" className="app-logo" />
        </div> */}

        <h1 className="text-2xl font-extrabold header-title text-center">INNOVEX</h1>

        <div className="flex gap-3 items-center">
        <img src="public/logo1.png" alt="Logo1" className="app-logo animate-float" />
        <img src="public/logo2.png" alt="Logo2" className="app-logo animate-float" />
      </div>

    </header>

    {/* RIGHT — TWO LOGOS */}
    {/* Navigation Bar */}
    <nav className="flex justify-center gap-3 mt-2 pb-2">
      <Link to="/requester" className="btn-ghost">Requester</Link>
      <Link to="/spoc" className="btn-ghost">SPOC</Link>
    </nav>

  {/* ---------- MAIN CONTENT ---------- */}
  <main className="max-w-4xl mx-auto p-4">
      <Routes>
        <Route path="/" element={<Navigate to="/requester" replace />} />
        <Route path="/requester" element={<RequesterPage />} />
        <Route path="/spoc" element={<SpocPage />} />
      </Routes>
      </main >
    </div >
  )
}
