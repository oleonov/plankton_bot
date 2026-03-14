import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { SSEProvider } from "./api/sse.tsx";
import { Layout } from "./components/Layout.tsx";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 1 } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SSEProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Navigate to="/overview" replace />} />
              <Route path="/overview" element={<div className="page">Overview — coming next</div>} />
              <Route path="/positions" element={<div className="page">Positions — coming next</div>} />
              <Route path="/orders" element={<div className="page">Orders — coming next</div>} />
              <Route path="/families" element={<div className="page">Families — coming next</div>} />
              <Route path="/risk" element={<div className="page">Risk — coming next</div>} />
            </Route>
          </Routes>
        </BrowserRouter>
      </SSEProvider>
    </QueryClientProvider>
  );
}
