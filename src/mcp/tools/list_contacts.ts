// SPDX-License-Identifier: LGPL-3.0-only
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceBag } from "../../service.ts";
import { agentResult } from "../agent.ts";
export function listContacts(server: McpServer, services: ServiceBag) {
  server.registerTool("list_contacts", {
    description:
      "Contacts with current key-contact and encryption-capable state.",
    inputSchema: z.object({ session_id: z.string().min(1).optional() }),
  }, (input, ctx) =>
    agentResult(services, ctx, input, async () => ({
      contacts: (await services.contacts.list()).map((contact) => ({
        id: contact.id,
        name: contact.displayName,
        address: contact.address,
        keyContact: contact.isKeyContact,
        encryptionAvailable: contact.e2eeAvail,
      })),
    })));
}
