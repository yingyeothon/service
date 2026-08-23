import { Link } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { Notice, Spinner } from "../components/ui";

export function HomePage() {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  return (
    <>
      <h1>yyt console</h1>
      {!me && (
        <Notice>
          <p>
            Operator console for the yyt.life contest services: auth, topic and
            match channels, API tokens for the <code>yyt</code> CLI, and
            hackathon events.
          </p>
          <a className="btn btn-primary" href={api.loginUrl("/")}>
            Sign in with GitHub
          </a>
          <p className="muted" style={{ marginTop: "0.6rem" }}>
            Published hackathon events are visible without signing in:{" "}
            <Link to="/events">Events</Link>.
          </p>
        </Notice>
      )}
      {me?.role === "pending" && (
        <Notice kind="warn">
          <p>
            Signed in as <strong>{me.login}</strong>. Your membership is{" "}
            <strong>pending</strong> — an admin has to approve it before you can
            create channels. Hackathon <Link to="/events">events</Link>{" "}
            (proposals, votes) are open to you already.
          </p>
        </Notice>
      )}
      {me && me.role !== "pending" && (
        <ul>
          <li>
            <Link to="/channels">Channels</Link> — auth / topic / match channels
            for your games.
          </li>
          <li>
            <Link to="/tokens">API tokens</Link> — for{" "}
            <code>yyt login --token …</code>.
          </li>
          <li>
            <Link to="/events">Events</Link> — hackathon proposals and votes.
          </li>
          {me.role === "admin" && (
            <li>
              <Link to="/members">Members</Link> — approve sign-ups.
            </li>
          )}
        </ul>
      )}
    </>
  );
}
