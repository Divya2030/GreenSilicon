import { BrowserRouter, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import { ConfigContext } from "./lib/context";
import { useApi } from "./lib/hooks";
import type { AppConfig } from "./lib/types";
import { ErrorBox, Loading } from "./components/ui";
import Overview from "./pages/Overview";
import Passports from "./pages/Passports";
import PassportDetail from "./pages/PassportDetail";
import DesignLab from "./pages/DesignLab";
import SupplierPortal from "./pages/SupplierPortal";
import Credits from "./pages/Credits";
import Verify from "./pages/Verify";
import Telemetry from "./pages/Telemetry";
import Suppliers from "./pages/Suppliers";
import Report from "./pages/Report";
import Compute from "./pages/Compute";

export default function App() {
  const { data: cfg, error } = useApi<AppConfig>("/config");
  return (
    <ConfigContext.Provider value={cfg}>
      <BrowserRouter>
        <Layout>
          {error ? (
            <ErrorBox error={`Backend unreachable (${error}). Start it with ./scripts/dev.sh`} />
          ) : !cfg ? (
            <Loading label="Connecting to GreenSilicon…" />
          ) : (
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/passports" element={<Passports />} />
              <Route path="/passport/:id" element={<PassportDetail />} />
              <Route path="/design" element={<DesignLab />} />
              <Route path="/submit" element={<SupplierPortal />} />
              <Route path="/credits" element={<Credits />} />
              <Route path="/telemetry" element={<Telemetry />} />
              <Route path="/suppliers" element={<Suppliers />} />
              <Route path="/compute" element={<Compute />} />
              <Route path="/report" element={<Report />} />
              <Route path="/verify" element={<Verify />} />
              <Route path="/verify/:id" element={<Verify />} />
            </Routes>
          )}
        </Layout>
      </BrowserRouter>
    </ConfigContext.Provider>
  );
}
