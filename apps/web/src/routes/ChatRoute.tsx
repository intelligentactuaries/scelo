// Wrapper around <Chat> that reads the :conversationId path param.
// Chat itself is built up over checkpoints 4–14.

import { useParams } from "react-router-dom";
import Chat from "./Chat";

export default function ChatRoute() {
  const { conversationId = "" } = useParams<{ conversationId: string }>();
  return <Chat conversationId={conversationId} />;
}
