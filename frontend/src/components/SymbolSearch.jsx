import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'

export default function SymbolSearch() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const boxRef = useRef(null)

  useEffect(() => {
    if (!query || query.length < 1) {
      setResults([])
      return
    }
    const handle = setTimeout(() => {
      api.search(query).then(setResults).catch(() => setResults([]))
    }, 250)
    return () => clearTimeout(handle)
  }, [query])

  useEffect(() => {
    function onClickOutside(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  function goTo(symbol) {
    setQuery('')
    setResults([])
    setOpen(false)
    navigate(`/analysis/${symbol}`)
  }

  return (
    <div className="symbol-search" ref={boxRef}>
      <input
        type="text"
        placeholder="Search ticker or company (e.g. AAPL, Tesla)"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && query.trim()) goTo(query.trim().toUpperCase())
        }}
      />
      {open && results.length > 0 && (
        <div className="search-dropdown">
          {results.map((r) => (
            <div key={r.symbol} className="search-result" onClick={() => goTo(r.symbol)}>
              <span className="result-symbol">{r.symbol}</span>
              <span className="result-name">{r.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
