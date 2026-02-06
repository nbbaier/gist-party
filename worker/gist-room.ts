import { YServer } from "y-partyserver";
import type { Connection } from "partyserver";

export class GistRoom extends YServer {
  static options = {
    hibernate: true,
  };

  onConnect(connection: Connection) {
    console.log(`[GistRoom] Connection ${connection.id} joined room ${this.name}`);
  }

  onClose(connection: Connection) {
    console.log(`[GistRoom] Connection ${connection.id} left room ${this.name}`);
  }
}
