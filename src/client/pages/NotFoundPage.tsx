import "./not-found-page.css";

export function NotFoundPage({ gistId }: { gistId: string }) {
  return (
    <div className="not-found-page">
      <h1>Not Found</h1>
      <p>
        The gist <code>{gistId}</code> is not hosted on gist.party.
      </p>
    </div>
  );
}
