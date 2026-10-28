import './App.css'

import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";

const Lobby = lazy(() => import("./pages/Lobby"));
const Table = lazy(() => import("./pages/Table"));

function App() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <Routes>
        <Route path="/" element={<Lobby />} />
        <Route path="/room/:code" element={<Table />} />
      </Routes>
    </Suspense>
  )
}

export default App
