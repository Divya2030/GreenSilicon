import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Contract, JsonRpcProvider, keccak256 } from "ethers";
import { BadgeCheck, FileSearch, KeyRound, Link2, Search, ShieldCheck, ShieldX } from "lucide-react";
import { useConfig, actorName } from "../lib/context";
import { PASSPORT_ABI, STAGES, STATUSES, VERDICTS } from "../lib/contract";
import { api } from "../lib/api";
import { ErrorBox, Hash, Loading, PageHeader, Pill, Section, VerdictBadge } from "../components/ui";
import { STAGE_LABEL, fmtCarbon, fmtNum, fmtTime } from "../lib/format";

type ChainStage = { stage: string; attester: string; timestamp: number; fieldsRoot: string; evidenceHash: string; carbonG: number; facility: string; verdict: (typeof VERDICTS)[number]; aiScore: number };
type ChainView = {
  product: string; processNode: string; units: number; status: string; owner: string; totalCarbonG: number; offsetG: number; waterL: number;
  verifiedShareBps: number; designCommitment: string; stages: ChainStage[]; block: number; chainId: number;
};

export default function Verify() {
  const cfg = useConfig()!;
  const { id } = useParams();
  const nav = useNavigate();
  const [rpc, setRpc] = useState(`${window.location.origin}/rpc`);
  const [address, setAddress] = useState(cfg.contracts.GreenSiliconPassport);
  const [input, setInput] = useState(id ?? "4");
  const [view, setView] = useState<ChainView | null>(null);
  const [serverMatch, setServerMatch] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const contract = useCallback(() => new Contract(address, PASSPORT_ABI, new JsonRpcProvider(rpc, undefined, { staticNetwork: true })), [rpc, address]);

  const load = useCallback(async (pid: string) => {
    setLoading(true);
    setErr(null);
    setView(null);
    setServerMatch(null);
    try {
      const c = contract();
      const provider = c.runner as JsonRpcProvider;
      const [p, stages, owner, share, net, block] = await Promise.all([
        c.getPassport(pid), c.getStages(pid), c.ownerOf(pid), c.verifiedShareBps(pid), provider.getNetwork(), provider.getBlockNumber(),
      ]);
      const v: ChainView = {
        product: p.product, processNode: p.processNode, units: Number(p.units), status: STATUSES[Number(p.status)], owner,
        totalCarbonG: Number(p.ownCarbonG + p.inheritedCarbonG), offsetG: Number(p.offsetG), waterL: Number(p.waterL),
        verifiedShareBps: Number(share), designCommitment: p.designCommitment, block, chainId: Number(net.chainId),
        stages: stages.map((s: { stage: bigint; attester: string; timestamp: bigint; fieldsRoot: string; evidenceHash: string; carbonG: bigint; facility: string; verdict: bigint; aiScore: bigint }) => ({
          stage: STAGES[Number(s.stage)], attester: s.attester, timestamp: Number(s.timestamp), fieldsRoot: s.fieldsRoot, evidenceHash: s.evidenceHash,
          carbonG: Number(s.carbonG), facility: s.facility, verdict: VERDICTS[Number(s.verdict)], aiScore: Number(s.aiScore),
        })),
      };
      setView(v);
      // Cross-check what our own API claims against the chain
      try {
        const srv = await api.get<{ totalCarbonG: number; offsetG: number; stages: unknown[] }>(`/passports/${pid}`);
        setServerMatch(srv.totalCarbonG === v.totalCarbonG && srv.offsetG === v.offsetG && srv.stages.length === v.stages.length);
      } catch {
        setServerMatch(null);
      }
    } catch (e) {
      const m = (e as Error).message;
      setErr(m.includes("UnknownPassport") || m.includes("execution reverted") ? `Passport #${pid} does not exist on this contract.` : m);
    } finally {
      setLoading(false);
    }
  }, [contract]);

  useEffect(() => {
    if (id) load(id);
  }, [id, load]);

  return (
    <>
      <PageHeader
        title="Public Verifier"
        subtitle="Verify any chip passport straight from the blockchain. This page queries the contract from your browser with its own ABI, recomputes document hashes locally and checks Merkle proofs on-chain. No trust in GreenSilicon's servers required."
      />

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5">
          <Section title="Look up a passport">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                nav(`/verify/${input}`);
                load(input);
              }}
            >
              <input className="input" value={input} onChange={(e) => setInput(e.target.value.replace(/\D/g, ""))} placeholder="Passport ID (scan the QR on the chip tray)" />
              <button className="btn-primary" aria-label="Verify">
                <Search size={15} />
              </button>
            </form>
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer muted">Use my own RPC / contract</summary>
              <div className="mt-2 space-y-2">
                <label className="block">
                  <span className="label">JSON-RPC endpoint</span>
                  <input className="input font-mono text-xs" value={rpc} onChange={(e) => setRpc(e.target.value)} />
                </label>
                <label className="block">
                  <span className="label">GreenSiliconPassport contract</span>
                  <input className="input font-mono text-xs" value={address} onChange={(e) => setAddress(e.target.value)} />
                </label>
              </div>
            </details>
          </Section>
          <EvidenceCheck stages={view?.stages ?? []} />
          <ProofCheck contract={contract} />
        </div>

        <div className="space-y-5 xl:col-span-2">
          {err && <ErrorBox error={err} />}
          {loading && <Loading label="Querying contract…" />}
          {view && (
            <>
              <Section
                title={`#${input} · ${view.product}`}
                right={
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                    <BadgeCheck size={14} /> read from chain {view.chainId} at block {view.block}
                  </span>
                }
              >
                <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                  <KV k="Footprint" v={fmtCarbon(view.totalCarbonG)} />
                  <KV k="Per unit" v={fmtCarbon(view.totalCarbonG / view.units)} />
                  <KV k="Offsets retired" v={fmtCarbon(view.offsetG)} />
                  <KV k="AI-verified share" v={`${(view.verifiedShareBps / 100).toFixed(0)}%`} />
                  <KV k="Node" v={view.processNode} />
                  <KV k="Units" v={fmtNum(view.units)} />
                  <KV k="Status" v={view.status} />
                  <KV k="Owner" v={actorName(cfg, view.owner)} />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
                  <span>Design commitment <Hash value={view.designCommitment} /></span>
                  <span>Contract <Hash value={address} /></span>
                  {serverMatch === true && (
                    <Pill tone="brand">
                      <ShieldCheck size={12} /> GreenSilicon API matches chain
                    </Pill>
                  )}
                  {serverMatch === false && (
                    <Pill tone="red">
                      <ShieldX size={12} /> API data differs from chain: trust the chain
                    </Pill>
                  )}
                </div>
              </Section>

              <Section title="On-chain lifecycle records">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="text-left text-xs muted">
                        <th className="pb-2 font-medium">Stage</th>
                        <th className="pb-2 font-medium">Attested by</th>
                        <th className="pb-2 text-right font-medium">CO₂e</th>
                        <th className="pb-2 font-medium">AI verdict</th>
                        <th className="pb-2 font-medium">Evidence hash</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.stages.map((s, i) => (
                        <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                          <td className="py-2">
                            <div className="font-medium">{STAGE_LABEL[s.stage]}</div>
                            <div className="text-xs muted">{fmtTime(s.timestamp)}</div>
                          </td>
                          <td className="py-2 text-xs">
                            <div>{actorName(cfg, s.attester)}</div>
                            <div className="muted">{s.facility}</div>
                          </td>
                          <td className="py-2 text-right tabular-nums">{fmtCarbon(s.carbonG)}</td>
                          <td className="py-2"><VerdictBadge v={s.verdict} score={s.aiScore / 100} /></td>
                          <td className="py-2"><Hash value={s.evidenceHash} n={4} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-xs muted">{k}</div>
      <div className="font-medium">{v}</div>
    </div>
  );
}

function EvidenceCheck({ stages }: { stages: ChainStage[] }) {
  const [res, setRes] = useState<{ hash: string; match: ChainStage | null; name: string } | null>(null);
  async function check(f: File) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const hash = keccak256(bytes);
    setRes({ hash, name: f.name, match: stages.find((s) => s.evidenceHash.toLowerCase() === hash.toLowerCase()) ?? null });
  }
  return (
    <Section title="Is this the anchored document?" right={<FileSearch size={15} className="text-slate-400" />}>
      <label className="btn-ghost w-full cursor-pointer">
        Choose a supplier document
        <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && check(e.target.files[0])} />
      </label>
      <p className="mt-2 text-xs muted">The file is hashed (keccak-256) in your browser and compared with the evidence hashes on-chain. A single changed byte breaks the match.</p>
      {res && (
        <div className={`mt-3 rounded-lg p-3 text-xs ${res.match ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-300"}`}>
          <div className="font-mono break-all">{res.hash}</div>
          <div className="mt-1 font-medium">
            {res.match ? `✓ Matches the ${STAGE_LABEL[res.match.stage]} record (${res.match.facility})` : stages.length ? "✗ No record on this passport anchors this document" : "Look up a passport first"}
          </div>
        </div>
      )}
    </Section>
  );
}

function ProofCheck({ contract }: { contract: () => Contract }) {
  const [text, setText] = useState("");
  const [res, setRes] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function check() {
    setErr(null);
    setRes(null);
    try {
      const j = JSON.parse(text);
      setRes(await contract().verifyField(j.passportId, j.index, j.key, j.value, j.salt, j.proof));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <Section title="Check a disclosure proof" right={<KeyRound size={15} className="text-slate-400" />}>
      <textarea className="input h-28 font-mono text-[11px]" placeholder='{"passportId":1,"index":0,"key":"abatement_rate","value":"0.99","salt":"0x…","proof":["0x…"]}' value={text} onChange={(e) => setText(e.target.value)} />
      <div className="mt-2 flex items-center gap-3">
        <button className="btn-ghost" onClick={check} disabled={!text}>
          <Link2 size={14} /> Verify against contract
        </button>
        {res === true && <span className="text-xs text-emerald-700 dark:text-emerald-400">✓ Field is part of the signed disclosure</span>}
        {res === false && <span className="text-xs text-red-700">✗ Proof does not match the on-chain root</span>}
      </div>
      {err && <p className="mt-2 text-xs text-red-700">{err}</p>}
      <p className="mt-2 text-xs muted">Suppliers share a proof package for one field (from the passport page) with an auditor or customer, without revealing anything else.</p>
    </Section>
  );
}
