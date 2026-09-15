import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import Dashboard from './pages/Dashboard.jsx'
import StockAnalysis from './pages/StockAnalysis.jsx'
import Watchlist from './pages/Watchlist.jsx'
import Portfolio from './pages/Portfolio.jsx'
import Alerts from './pages/Alerts.jsx'

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/analysis" element={<StockAnalysis />} />
        <Route path="/analysis/:symbol" element={<StockAnalysis />} />
        <Route path="/watchlist" element={<Watchlist />} />
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="/alerts" element={<Alerts />} />
      </Routes>
    </Layout>
  )
}
