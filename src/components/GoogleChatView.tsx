import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ExternalLink,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  X,
} from 'lucide-react';
import firebaseConfig from '../../firebase-applet-config.json';
import { useAuth } from '../context/AuthContext';

interface ChatSpace {
  name: string;
  displayName?: string;
  spaceType?: 'SPACE' | 'GROUP_CHAT' | 'DIRECT_MESSAGE' | string;
  singleUserBotDm?: boolean;
  spaceThreadingState?: string;
}

interface ChatMessage {
  name: string;
  sender?: {
    name?: string;
    displayName?: string;
    type?: string;
  };
  createTime?: string;
  text?: string;
  formattedText?: string;
  thread?: {
    name?: string;
  };
}

interface ChatErrorState {
  status?: number;
  message: string;
  isAppNotConfigured?: boolean;
}

const CHAT_CONSOLE_URL = `https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=${firebaseConfig.projectId}`;

function formatChatTime(iso?: string): string {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSpaceType(spaceType?: string): string {
  if (spaceType === 'DIRECT_MESSAGE') return 'Direct Message';
  if (spaceType === 'GROUP_CHAT') return 'Group Chat';
  if (spaceType === 'SPACE') return 'Space';
  return spaceType || 'Conversation';
}

function getSpaceLabel(space: ChatSpace): string {
  if (space.displayName && space.displayName.trim()) {
    return space.displayName;
  }
  const shortId = space.name.split('/').pop() || space.name;
  return `${formatSpaceType(space.spaceType)} · ${shortId}`;
}

export function GoogleChatView() {
  const {
    user,
    googleAccessToken,
    signInWithGoogle,
    clearGoogleAccessToken,
    authError,
  } = useAuth();

  const [spaces, setSpaces] = useState<ChatSpace[]>([]);
  const [selectedSpaceName, setSelectedSpaceName] = useState<string>('');
  const [spaceSearch, setSpaceSearch] = useState('');
  const [loadingSpaces, setLoadingSpaces] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const [chatError, setChatError] = useState<ChatErrorState | null>(null);
  const [draftMessage, setDraftMessage] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendSuccessBanner, setSendSuccessBanner] = useState<string | null>(null);

  const parseApiError = useCallback(
    async (res: Response): Promise<ChatErrorState> => {
      let message = `Google Chat request failed (HTTP ${res.status}).`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body?.error?.message) {
          message = body.error.message;
        }
      } catch {
        // Fallback to status message
      }

      if (res.status === 401) {
        clearGoogleAccessToken();
      }

      const isAppNotConfigured =
        res.status === 404 ||
        message.toLowerCase().includes('google chat app not found') ||
        message.toLowerCase().includes('configure the app');

      return {
        status: res.status,
        message,
        isAppNotConfigured,
      };
    },
    [clearGoogleAccessToken],
  );

  const fetchSpaces = useCallback(async () => {
    if (!googleAccessToken) return;
    setLoadingSpaces(true);
    setChatError(null);
    try {
      const res = await fetch('https://chat.googleapis.com/v1/spaces?pageSize=50', {
        headers: {
          Authorization: `Bearer ${googleAccessToken}`,
        },
      });
      if (!res.ok) {
        const parsedErr = await parseApiError(res);
        setChatError(parsedErr);
        return;
      }
      const data = (await res.json()) as { spaces?: ChatSpace[] };
      const list = Array.isArray(data.spaces) ? data.spaces : [];
      setSpaces(list);
      setSelectedSpaceName((prev) => {
        if (prev && list.some((s) => s.name === prev)) return prev;
        return list[0]?.name || '';
      });
    } catch (err) {
      setChatError({
        message:
          err instanceof Error
            ? err.message
            : 'Unable to reach Google Chat service.',
      });
    } finally {
      setLoadingSpaces(false);
    }
  }, [googleAccessToken, parseApiError]);

  const fetchMessages = useCallback(
    async (spaceName: string) => {
      if (!googleAccessToken || !spaceName) return;
      setLoadingMessages(true);
      setChatError(null);
      try {
        const res = await fetch(
          `https://chat.googleapis.com/v1/${spaceName}/messages?pageSize=50&orderBy=createTime%20desc`,
          {
            headers: {
              Authorization: `Bearer ${googleAccessToken}`,
            },
          },
        );
        if (!res.ok) {
          const parsedErr = await parseApiError(res);
          setChatError(parsedErr);
          return;
        }
        const data = (await res.json()) as { messages?: ChatMessage[] };
        const items = Array.isArray(data.messages) ? [...data.messages].reverse() : [];
        setMessages(items);
      } catch (err) {
        setChatError({
          message:
            err instanceof Error
              ? err.message
              : 'Unable to load messages for this space.',
        });
      } finally {
        setLoadingMessages(false);
      }
    },
    [googleAccessToken, parseApiError],
  );

  useEffect(() => {
    if (googleAccessToken) {
      void fetchSpaces();
    } else {
      setSpaces([]);
      setMessages([]);
      setSelectedSpaceName('');
    }
  }, [googleAccessToken, fetchSpaces]);

  useEffect(() => {
    if (googleAccessToken && selectedSpaceName) {
      void fetchMessages(selectedSpaceName);
    } else {
      setMessages([]);
    }
  }, [googleAccessToken, selectedSpaceName, fetchMessages]);

  const selectedSpace = useMemo(
    () => spaces.find((s) => s.name === selectedSpaceName) || null,
    [spaces, selectedSpaceName],
  );

  const filteredSpaces = useMemo(() => {
    const q = spaceSearch.trim().toLowerCase();
    if (!q) return spaces;
    return spaces.filter((s) => {
      const hay = `${s.displayName || ''} ${s.name} ${s.spaceType || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [spaces, spaceSearch]);

  const handleRequestSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSpace || !draftMessage.trim()) return;
    setSendSuccessBanner(null);
    setConfirmOpen(true);
  };

  const handleConfirmSend = async () => {
    if (!googleAccessToken || !selectedSpace) return;
    const text = draftMessage.trim();
    if (!text) return;

    setSending(true);
    setChatError(null);
    try {
      const res = await fetch(
        `https://chat.googleapis.com/v1/${selectedSpace.name}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${googleAccessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text }),
        },
      );
      if (!res.ok) {
        const parsedErr = await parseApiError(res);
        setChatError(parsedErr);
        setConfirmOpen(false);
        return;
      }

      setDraftMessage('');
      setConfirmOpen(false);
      setSendSuccessBanner(
        `Message delivered to ${getSpaceLabel(selectedSpace)}.`,
      );
      await fetchMessages(selectedSpace.name);
    } catch (err) {
      setChatError({
        message:
          err instanceof Error
            ? err.message
            : 'Unable to send message to Google Chat.',
      });
      setConfirmOpen(false);
    } finally {
      setSending(false);
    }
  };

  if (!googleAccessToken) {
    return (
      <div className="space-y-6">
        <section className="bg-white border border-slate-200 rounded-xl p-6 lg:p-8 max-w-3xl">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center shrink-0">
              <MessageSquare className="w-5 h-5 text-slate-700" />
            </div>
            <div className="space-y-4 flex-1">
              <div>
                <h2 className="text-xl font-semibold text-slate-900 font-display">
                  Connect Google Chat
                </h2>
                <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                  Authorize your Google Workspace session to browse Google Chat spaces, read team
                  threads, and send messages directly from Veridian Ledger. Access tokens are held
                  strictly in memory for this session.
                </p>
              </div>

              {authError && (
                <div className="p-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {authError}
                </div>
              )}

              <div>
                <button
                  type="button"
                  onClick={() => void signInWithGoogle()}
                  className="inline-flex items-center gap-3 px-4 py-2.5 bg-white border border-slate-300 rounded-lg text-sm font-medium text-slate-800 hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 48 48"
                    className="w-4 h-4 shrink-0"
                    aria-hidden="true"
                  >
                    <path
                      fill="#EA4335"
                      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                    />
                    <path
                      fill="#4285F4"
                      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                    />
                    <path
                      fill="#34A853"
                      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                    />
                  </svg>
                  <span>Sign in with Google</span>
                </button>
              </div>

              <div className="pt-4 border-t border-slate-200 space-y-2 text-xs text-slate-600">
                <p className="font-medium text-slate-900">Google Chat Prerequisites</p>
                <p>
                  1. Requires a Business or Enterprise Google Workspace account with Google Chat
                  enabled (consumer <span className="font-mono">@gmail.com</span> accounts are not
                  supported by the Google Chat API).
                </p>
                <p>
                  2. Requires one-time Chat app configuration (App name, Avatar URL, Description) in
                  Google Cloud Console for project{' '}
                  <span className="font-mono">{firebaseConfig.projectId}</span>:{' '}
                  <a
                    href={CHAT_CONSOLE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-slate-900 underline hover:text-slate-700"
                  >
                    <span>Open Google Chat API Configuration</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </p>
                {user?.email && (
                  <p className="text-slate-500 pt-1">
                    Signed-in Workspace identity: <span className="font-mono">{user.email}</span>
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 font-display">
            Google Chat Spaces &amp; Messaging
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {user?.email || 'Workspace Session'} · {spaces.length} space
            {spaces.length === 1 ? '' : 's'} loaded
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void fetchSpaces()}
            disabled={loadingSpaces}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingSpaces ? 'animate-spin' : ''}`} />
            <span>Refresh Spaces</span>
          </button>
          <button
            type="button"
            onClick={() => void signInWithGoogle()}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer whitespace-nowrap shrink-0"
          >
            <span>Switch Account</span>
          </button>
        </div>
      </div>

      {chatError && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3 text-xs text-red-800">
          <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
          <div className="space-y-2 flex-1">
            <p className="font-medium text-red-900">{chatError.message}</p>
            {chatError.isAppNotConfigured && (
              <p className="text-red-800">
                Complete the one-time Chat app setup (App name, Avatar URL, Description) on the{' '}
                <a
                  href={CHAT_CONSOLE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium underline hover:text-red-950"
                >
                  <span>Google Chat API Configuration page</span>
                  <ExternalLink className="w-3 h-3" />
                </a>{' '}
                for project <span className="font-mono">{firebaseConfig.projectId}</span>, then
                click Refresh Spaces.
              </p>
            )}
            {chatError.status === 403 && (
              <p className="text-red-800">
                Google Chat API access requires a Business or Enterprise Google Workspace account
                with Google Chat enabled. Consumer <span className="font-mono">@gmail.com</span>{' '}
                accounts cannot list or post to Chat spaces.
              </p>
            )}
          </div>
        </div>
      )}

      {sendSuccessBanner && (
        <div className="flex items-center justify-between gap-4 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800">
          <span>{sendSuccessBanner}</span>
          <button
            type="button"
            onClick={() => setSendSuccessBanner(null)}
            className="text-emerald-700 hover:text-emerald-900 cursor-pointer"
            aria-label="Dismiss confirmation"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Spaces Sidebar */}
        <section className="lg:col-span-4 bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden min-h-[520px]">
          <div className="p-4 border-b border-slate-200">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={spaceSearch}
                onChange={(e) => setSpaceSearch(e.target.value)}
                placeholder="Filter spaces..."
                className="w-full pl-9 pr-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {loadingSpaces ? (
              <div className="p-4 space-y-3">
                {[1, 2, 3, 4].map((row) => (
                  <div key={row} className="h-12 bg-slate-100 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : filteredSpaces.length === 0 ? (
              <div className="p-8 text-center space-y-2">
                <p className="text-sm font-medium text-slate-900">No Google Chat spaces found</p>
                <p className="text-xs text-slate-500">
                  {spaces.length === 0
                    ? 'No spaces are accessible for this account yet, or the Chat app setup is still pending.'
                    : 'No spaces match your search filter.'}
                </p>
              </div>
            ) : (
              filteredSpaces.map((space) => {
                const isSelected = space.name === selectedSpaceName;
                return (
                  <button
                    key={space.name}
                    type="button"
                    onClick={() => setSelectedSpaceName(space.name)}
                    className={`w-full text-left px-4 py-3.5 transition-colors cursor-pointer ${
                      isSelected ? 'bg-slate-900 text-white' : 'hover:bg-slate-50 text-slate-900'
                    }`}
                  >
                    <p className="text-sm font-medium truncate">{getSpaceLabel(space)}</p>
                    <p
                      className={`text-xs mt-0.5 truncate ${
                        isSelected ? 'text-slate-300' : 'text-slate-500'
                      }`}
                    >
                      {formatSpaceType(space.spaceType)} ·{' '}
                      <span className="font-mono">{space.name}</span>
                    </p>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* Active Conversation & Composer */}
        <section className="lg:col-span-8 bg-white border border-slate-200 rounded-xl flex flex-col overflow-hidden min-h-[520px]">
          {!selectedSpace ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-2">
              <MessageSquare className="w-6 h-6 text-slate-400" />
              <p className="text-sm font-medium text-slate-900">Select a Google Chat space</p>
              <p className="text-xs text-slate-500 max-w-sm">
                Choose a room, group chat, or direct message on the left to inspect messages and
                send replies.
              </p>
            </div>
          ) : (
            <>
              <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-slate-900 font-display truncate">
                    {getSpaceLabel(selectedSpace)}
                  </h3>
                  <p className="text-xs text-slate-500 truncate">
                    {formatSpaceType(selectedSpace.spaceType)} ·{' '}
                    <span className="font-mono">{selectedSpace.name}</span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void fetchMessages(selectedSpace.name)}
                  disabled={loadingMessages}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingMessages ? 'animate-spin' : ''}`} />
                  <span>Reload</span>
                </button>
              </div>

              <div className="flex-1 p-5 overflow-y-auto space-y-4 max-h-[420px]">
                {loadingMessages ? (
                  <div className="space-y-3">
                    {[1, 2, 3].map((row) => (
                      <div key={row} className="h-14 bg-slate-100 rounded-lg animate-pulse" />
                    ))}
                  </div>
                ) : messages.length === 0 ? (
                  <div className="py-12 text-center space-y-1">
                    <p className="text-sm font-medium text-slate-900">No messages yet</p>
                    <p className="text-xs text-slate-500">
                      Send the first message below to start the conversation in this space.
                    </p>
                  </div>
                ) : (
                  messages.map((msg) => {
                    const senderName =
                      msg.sender?.displayName ||
                      msg.sender?.name ||
                      'Workspace Member';
                    return (
                      <div key={msg.name} className="pb-3 border-b border-slate-100 last:border-b-0">
                        <div className="flex items-center justify-between gap-4 text-xs">
                          <span className="font-medium text-slate-900">{senderName}</span>
                          <span className="text-slate-400 font-mono tabular-nums whitespace-nowrap">
                            {formatChatTime(msg.createTime)}
                          </span>
                        </div>
                        <p className="text-sm text-slate-700 mt-1 whitespace-pre-wrap break-words">
                          {msg.text || msg.formattedText || '(Attachment or card message)'}
                        </p>
                      </div>
                    );
                  })
                )}
              </div>

              <form
                onSubmit={handleRequestSend}
                className="p-4 border-t border-slate-200 bg-slate-50 flex items-end gap-3"
              >
                <div className="flex-1">
                  <label htmlFor="chat-composer" className="sr-only">
                    Message text
                  </label>
                  <textarea
                    id="chat-composer"
                    rows={2}
                    value={draftMessage}
                    onChange={(e) => setDraftMessage(e.target.value)}
                    placeholder={`Message ${getSpaceLabel(selectedSpace)}...`}
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!draftMessage.trim() || sending}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Send Message</span>
                </button>
              </form>
            </>
          )}
        </section>
      </div>

      {/* Explicit Confirmation Dialog Before Sending Chat Message */}
      {confirmOpen && selectedSpace && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-chat-send-title"
        >
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <h3
                id="confirm-chat-send-title"
                className="text-base font-semibold text-slate-900 font-display"
              >
                Send Google Chat Message?
              </h3>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
                aria-label="Close confirmation"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="mt-4 space-y-3 text-xs text-slate-600">
              <p>
                This will post a message on your behalf to{' '}
                <span className="font-medium text-slate-900">
                  {getSpaceLabel(selectedSpace)}
                </span>{' '}
                (<span className="font-mono">{selectedSpace.name}</span>).
              </p>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                {draftMessage.trim()}
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={sending}
                className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmSend()}
                disabled={sending}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{sending ? 'Sending...' : 'Confirm & Send'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
