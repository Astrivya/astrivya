import { Calendar, FileCode2, GitCommitHorizontal, Hash, MessageSquare, Scale, Users } from "lucide-react";
import type {
  DecisionProvenance,
  ProvenanceCommit,
  ProvenanceDecision,
  ProvenanceFile,
  ProvenanceMessage,
  ProvenanceWho,
} from "../api/akg-client";

interface ProvenancePanelProps {
  provenance: DecisionProvenance | null;
  loading: boolean;
  onNavigate: (id: string) => void;
}

function fmtDate(ts: number | string): string {
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function relationBadge(relation: string): string {
  return relation.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function WhoRow({ who, onNavigate }: { who: ProvenanceWho; onNavigate: (id: string) => void }) {
  return (
    <button type="button" className="provenance-chip person" onClick={() => onNavigate(who.id)} title={who.id}>
      <Users size={11} />
      <span className="provenance-chip-label">{who.label}</span>
      <span className="provenance-chip-relation">{relationBadge(who.relation)}</span>
    </button>
  );
}

function FileRow({ file, onNavigate }: { file: ProvenanceFile; onNavigate: (id: string) => void }) {
  return (
    <button
      type="button"
      className="provenance-chip file"
      onClick={() => onNavigate(file.id)}
      title={file.path || file.id}
    >
      <FileCode2 size={11} />
      <span className="provenance-chip-label">{file.label}</span>
      <span className="provenance-chip-relation">{relationBadge(file.relation)}</span>
    </button>
  );
}

function CommitRow({ commit }: { commit: ProvenanceCommit }) {
  return (
    <div className="provenance-commit">
      <span className="provenance-commit-hash">{commit.hash}</span>
      <div className="provenance-commit-main">
        <span className="provenance-commit-subject">{commit.subject}</span>
        <span className="provenance-commit-meta">
          {commit.author} · {fmtDate(commit.date)}
        </span>
      </div>
    </div>
  );
}

function DecisionRow({ d, onNavigate }: { d: ProvenanceDecision; onNavigate: (id: string) => void }) {
  return (
    <button type="button" className="provenance-chip decision" onClick={() => onNavigate(d.id)} title={d.id}>
      <Scale size={11} />
      <span className="provenance-chip-label">{d.label}</span>
      <span className={`provenance-chip-relation ${d.relation}`}>{d.relation === "earlier" ? "Earlier" : "Later"}</span>
    </button>
  );
}

function MessageRow({ m }: { m: ProvenanceMessage }) {
  return (
    <div className="provenance-message">
      <div className="provenance-message-head">
        <span className="provenance-message-from">{m.fromName}</span>
        <span className="provenance-message-type">{m.msgType}</span>
        <span className="provenance-message-ts">{fmtDate(m.ts)}</span>
      </div>
      <p className="provenance-message-text">{m.text}</p>
    </div>
  );
}

function Section({
  icon,
  title,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="provenance-section">
      <div className="provenance-section-head">
        <span className="provenance-section-title">
          {icon}
          {title}
        </span>
        {count !== undefined && <span className="provenance-section-count">{count}</span>}
      </div>
      {children}
    </div>
  );
}

export function ProvenancePanel({ provenance, loading, onNavigate }: ProvenancePanelProps) {
  if (loading) {
    return (
      <div className="provenance-loading">
        <div className="provenance-loading-spinner" />
        <p>Tracing decision provenance…</p>
      </div>
    );
  }

  if (!provenance) {
    return (
      <div className="provenance-loading">
        <Hash size={20} />
        <p>No provenance data yet.</p>
      </div>
    );
  }

  const { node, confidence } = provenance;
  const pct = Math.round(confidence * 100);

  return (
    <div className="provenance">
      <div className="provenance-hero">
        <span className="provenance-hero-type">{node.type}</span>
        <h3 className="provenance-hero-label">{node.label}</h3>
        <div className="provenance-hero-meta">
          <Calendar size={11} />
          {fmtDate(node.createdAt)}
          {node.community !== null && node.community !== undefined && (
            <>
              <span className="provenance-hero-sep">·</span> cluster {node.community}
            </>
          )}
        </div>
        {node.content && <p className="provenance-hero-content">{node.content}</p>}
      </div>

      <div className="provenance-confidence">
        <div className="provenance-confidence-row">
          <span className="provenance-confidence-label">Evidence confidence</span>
          <span className="provenance-confidence-pct">{pct}%</span>
        </div>
        <div className="provenance-confidence-track">
          <div className="provenance-confidence-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <Section icon={<Users size={12} />} title="Who decided" count={provenance.who.length}>
        {provenance.who.length === 0 ? (
          <p className="provenance-empty">No linked authors — the decision was logged without a person edge.</p>
        ) : (
          <div className="provenance-chips">
            {provenance.who.map((w) => (
              <WhoRow key={w.id} who={w} onNavigate={onNavigate} />
            ))}
          </div>
        )}
      </Section>

      <Section icon={<FileCode2 size={12} />} title="Affected files" count={provenance.affectedFiles.length}>
        {provenance.affectedFiles.length === 0 ? (
          <p className="provenance-empty">No affected files recorded.</p>
        ) : (
          <div className="provenance-chips">
            {provenance.affectedFiles.map((f) => (
              <FileRow key={f.id} file={f} onNavigate={onNavigate} />
            ))}
          </div>
        )}
      </Section>

      <Section icon={<GitCommitHorizontal size={12} />} title="Commits in window" count={provenance.commits.length}>
        {provenance.commits.length === 0 ? (
          <p className="provenance-empty">No commits found in the ±14 day window around this decision.</p>
        ) : (
          <div className="provenance-commits">
            {provenance.commits.map((c: ProvenanceCommit) => (
              <CommitRow key={c.hash} commit={c} />
            ))}
          </div>
        )}
      </Section>

      <Section icon={<Scale size={12} />} title="Related decisions" count={provenance.relatedDecisions.length}>
        {provenance.relatedDecisions.length === 0 ? (
          <p className="provenance-empty">No other decision records found.</p>
        ) : (
          <div className="provenance-chips">
            {provenance.relatedDecisions.map((d: ProvenanceDecision) => (
              <DecisionRow key={d.id} d={d} onNavigate={onNavigate} />
            ))}
          </div>
        )}
      </Section>

      <Section icon={<MessageSquare size={12} />} title="Source conversation" count={provenance.conversation.length}>
        {provenance.conversation.length === 0 ? (
          <p className="provenance-empty">No mesh journal messages near this decision date.</p>
        ) : (
          <div className="provenance-messages">
            {provenance.conversation.map((m: ProvenanceMessage, i: number) => (
              <MessageRow key={`${m.ts}-${i}`} m={m} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
