import { useEffect, useRef, useState } from 'react';
import { coreClient } from '../lib/client';
import { fmtTime } from '../lib/format';
import type {
  ApprovalCardPayload,
  ChatMessage,
  DisambiguationRequest,
  OptionItem,
  StateSnapshot,
} from '../lib/types';
import { ApprovalCard } from './ApprovalCard';

export function Chat(props: { snapshot: StateSnapshot }): JSX.Element {
  const { snapshot } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snapshot.chat.length, snapshot.disambiguations.length]);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText('');
    setSendError(null);
    try {
      await coreClient.sendChat(trimmed);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  // Disambiguations already surfaced as chat messages should not be repeated.
  const inlineDisambiguationIds = new Set(
    snapshot.chat
      .filter((m) => m.kind === 'disambiguation')
      .map((m) => (m.payload as DisambiguationRequest | undefined)?.id)
      .filter((id): id is string => typeof id === 'string'),
  );
  const pendingDisambiguations = snapshot.disambiguations.filter(
    (d) => !d.resolvedEntityId && !inlineDisambiguationIds.has(d.id),
  );

  return (
    <div className="chat">
      <div className="pane-title">Chat</div>
      <div className="chat-scroll" ref={scrollRef}>
        {snapshot.chat.length === 0 && pendingDisambiguations.length === 0 ? (
          <div className="chat-empty">
            No conversation yet. Anticipy is listening for episodes; say something below.
          </div>
        ) : null}
        {snapshot.chat.map((message) => (
          <Message key={message.id} message={message} snapshot={snapshot} />
        ))}
        {pendingDisambiguations.map((request) => (
          <div key={request.id} className="msg msg-anticipy">
            <div className="msg-meta">
              <span className="msg-role role-anticipy">anticipy</span>
              <span className="msg-time">{fmtTime(request.createdAt)}</span>
            </div>
            <DisambiguationCard request={request} />
          </div>
        ))}
      </div>
      {sendError ? <div className="card-error chat-send-error">{sendError}</div> : null}
      <form
        className="chat-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className="chat-input"
          placeholder="Message Anticipy…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Chat message"
        />
        <button className="btn btn-send" type="submit" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

function Message(props: { message: ChatMessage; snapshot: StateSnapshot }): JSX.Element {
  const { message, snapshot } = props;
  const roleClass = `msg msg-${message.role}`;

  return (
    <div className={roleClass}>
      <div className="msg-meta">
        <span className={`msg-role role-${message.role}`}>{message.role}</span>
        <span className="msg-time">{fmtTime(message.at)}</span>
        {message.outcomeId ? <span className="msg-outcome">{message.outcomeId}</span> : null}
      </div>
      {message.text ? <div className="msg-text">{message.text}</div> : null}
      <MessageBody message={message} snapshot={snapshot} />
    </div>
  );
}

function MessageBody(props: { message: ChatMessage; snapshot: StateSnapshot }): JSX.Element | null {
  const { message, snapshot } = props;

  if (message.kind === 'approval-card') {
    const payload = (message.payload ?? {}) as ApprovalCardPayload;
    const outcome = snapshot.outcomes.find((o) => o.id === message.outcomeId);
    return <ApprovalCard messageId={message.id} payload={payload} outcome={outcome} />;
  }

  if (message.kind === 'options') {
    const options = Array.isArray(message.payload) ? (message.payload as OptionItem[]) : [];
    return <OptionButtons options={options} />;
  }

  if (message.kind === 'disambiguation') {
    const request = message.payload as DisambiguationRequest | undefined;
    if (!request || !Array.isArray(request.candidates)) return null;
    const live = snapshot.disambiguations.find((d) => d.id === request.id) ?? request;
    return <DisambiguationCard request={live} />;
  }

  if (message.kind === 'notification') {
    return <div className="msg-notification">notification</div>;
  }

  return null;
}

function OptionButtons(props: { options: OptionItem[] }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  if (props.options.length === 0) return <div className="card-empty">no options provided</div>;

  const choose = async (label: string) => {
    setError(null);
    try {
      // Options are display-only: choosing one posts the label back as a chat message.
      await coreClient.sendChat(label);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="options-card">
      {props.options.map((option) => (
        <button
          key={option.optionId}
          className="btn btn-option"
          onClick={() => void choose(option.label)}
        >
          {option.label}
        </button>
      ))}
      {error ? <div className="card-error">{error}</div> : null}
    </div>
  );
}

function DisambiguationCard(props: { request: DisambiguationRequest }): JSX.Element {
  const { request } = props;
  const [error, setError] = useState<string | null>(null);
  const resolved = Boolean(request.resolvedEntityId);

  const answer = async (entityId: string) => {
    setError(null);
    try {
      await coreClient.answerDisambiguation(request.id, entityId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="disambiguation-card">
      <div className="card-heading">who do you mean?</div>
      <div className="disambiguation-question">{request.question}</div>
      <div className="disambiguation-mention">
        mention: <code>{request.mention}</code>
      </div>
      <div className="disambiguation-candidates">
        {request.candidates.map((candidate) => (
          <button
            key={candidate.entityId}
            className={`btn btn-candidate${
              request.resolvedEntityId === candidate.entityId ? ' btn-chosen' : ''
            }`}
            disabled={resolved}
            onClick={() => void answer(candidate.entityId)}
          >
            <span>{candidate.label}</span>
            <span className="candidate-confidence">
              {(candidate.confidence * 100).toFixed(0)}%
            </span>
          </button>
        ))}
      </div>
      {resolved ? <div className="card-notice">resolved</div> : null}
      {error ? <div className="card-error">{error}</div> : null}
    </div>
  );
}
