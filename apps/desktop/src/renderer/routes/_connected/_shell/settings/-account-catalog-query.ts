import { queryOptions } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";

/**
 * Returns the query options that read an account's whole Model Catalog
 * (`providerAccount.readCatalog`), for the picker and the model browser.
 *
 * The query is keyed on the account and on `catalogReadAt`, the time of the
 * catalog's last read, so a Refresh that finished reads the catalog again. A
 * read that answers after a newer key was asked for lands in the older key and
 * is never shown. The query is removed the moment its last reader unmounts
 * (`gcTime: 0`), so no other screen ever holds the catalog, and it is never
 * read again behind the user's back (`staleTime: Infinity`; the live
 * connection does not keep it current).
 */
export const accountCatalogQuery = (
  client: HerculeClient,
  providerAccountId: string,
  catalogReadAt: string | null,
) =>
  queryOptions({
    queryKey: ["model-catalog", providerAccountId, catalogReadAt],
    queryFn: () => client.providerAccount.readCatalog({ params: { id: providerAccountId } }),
    gcTime: 0,
    staleTime: Infinity,
  });
