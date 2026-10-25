// SPDX-License-Identifier: LGPL-3.0-only
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServiceBag } from "../../service.ts";
import { toolResult } from "../result.ts";
export function listContacts(server: McpServer, services: ServiceBag) {
  server.registerTool("list_contacts", {
    description:
      "Contacts with current key-contact and encryption-capable state.",
    inputSchema: z.object({}),
  }, () =>
    toolResult(async () => ({
      contacts: (await services.contacts.list()).map((contact) => ({
        id: contact.id,
        name: contact.displayName,
        address: contact.address,
        keyContact: contact.isKeyContact,
        encryptionAvailable: contact.e2eeAvail,
      })),
    })));
}
