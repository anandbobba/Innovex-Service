// client/src/components/Layout.jsx
import React from 'react';

export default function Layout({ children }) {
  return (
    <div className="min-h-screen bg-gray-50 relative">
      {/* Top-right logo */}
      <div className="fixed top-4 right-4 z-50">
        <div className="flex items-center gap-2 p-1 rounded-lg bg-white/80 shadow-sm backdrop-blur-sm">
          <img src="/logo.png" alt="logo" className="app-logo animate-float" />
          <div className="hidden sm:block">
            <div className="text-sm font-semibold text-brand-700">Team Requests</div>
            <div className="text-xs text-gray-500">v1 · internal</div>
          </div>
        </div>
      </div>

      {/* Header bar (optional) */}
      <header className="w-full border-b border-gray-200 py-3 bg-white/60">
        <div className="max-w-6xl mx-auto px-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-brand-500 flex items-center justify-center text-white font-bold">TR</div>
            <div className="text-lg font-bold text-brand-700">Team Service Requests</div>
          </div>
          <div className="text-sm text-gray-600">Welcome</div>
        </div>
      </header>

      {/* content */}
      <main className="max-w-6xl mx-auto px-4 py-6">
        {children}
      </main>
    </div>
  );
}
