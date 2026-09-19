/**
 * Dev-only gallery: the dashboard's charts and widgets rendered from fixture data
 * (web/dev-fixtures, captured from a real Level 1 run). No server or sign-in needed.
 * Open http://localhost:5173/gallery.html while `npm run dev:web` runs. Not in the build.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { StateSnapshot, StatsResponse, TimeseriesResponse } from "@gpa/shared";
import state from "../dev-fixtures/state.json";
import stats from "../dev-fixtures/stats.json";
import timeseries from "../dev-fixtures/timeseries.json";
import { ChartFrame, Legend, LineChart, StackBar } from "./components/charts";
import { SpotMap } from "./components/site";
import { Badge, Card, ToastProvider } from "./components/ui";
import { fmtTime } from "./lib/format";
import { StatsBody } from "./pages/Stats";
import "./styles.css";

const s = state as unknown as StateSnapshot;
const ts = timeseries as unknown as TimeseriesResponse;

function Gallery() {
  const pts = ts.points;
  return (
    <main className="content page">
      <h1>Dashboard gallery <Badge tone="info">fixtures</Badge></h1>
      <Card title="Hero bar">
        <StackBar total={30} parts={[{ label: "Occupied", value: 12, color: "var(--s1)" }, { label: "Reserved", value: 2, color: "var(--s2)" },
          { label: "Free", value: 15, color: "var(--free-fill)" }, { label: "Out of service", value: 1, color: "var(--critical)" }]} />
      </Card>
      <ChartFrame title="Occupancy and queue" subtitle="Real run, per minute"
        legend={<Legend items={[{ label: "Cars parked or on their way", color: "var(--s1)", kind: "line" }, { label: "Waiting at entry", color: "var(--s2)", kind: "line" }]} />}
        table={{ columns: [{ key: "t", label: "Time" }, { key: "o", label: "Occupied", align: "right" }], rows: pts.map((p) => ({ t: fmtTime(p.t), o: p.occupied })) }}>
        <LineChart ariaLabel="occupancy" x={pts.map((p) => p.t)} xFormat={fmtTime} area reference={{ value: 30, label: "capacity 30" }}
          series={[{ key: "o", label: "Parked or on their way", color: "var(--s1)", values: pts.map((p) => p.occupied + p.reserved) },
            { key: "q", label: "Waiting at entry", color: "var(--s2)", values: pts.map((p) => p.queued) }]} />
      </ChartFrame>
      <Card title="Spot map"><SpotMap spots={s.spots} onSelect={() => undefined} /></Card>
      <StatsBody d={stats as unknown as StatsResponse} spots={s.spots} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><ToastProvider><Gallery /></ToastProvider></StrictMode>);
