import { useEffect, useState } from 'react';
import { coreClient, type ClientState } from './lib/client';
import { Header } from './components/Header';
import { Chat } from './components/Chat';
import { Inspector } from './components/Inspector';

export function App(): JSX.Element {
  const [client, setClient] = useState<ClientState>(() => coreClient.getState());

  useEffect(() => {
    const unsubscribe = coreClient.subscribe(setClient);
    coreClient.start();
    return () => {
      unsubscribe();
      coreClient.stop();
    };
  }, []);

  const { snapshot, status } = client;

  return (
    <div className="app">
      <Header snapshot={snapshot} status={status} />
      <main className="app-main">
        <section className="pane pane-chat" aria-label="Chat">
          <Chat snapshot={snapshot} />
        </section>
        <section className="pane pane-inspector" aria-label="Inspector">
          <Inspector snapshot={snapshot} />
        </section>
      </main>
    </div>
  );
}
