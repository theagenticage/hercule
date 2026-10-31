import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  NO_MODEL_FACETS,
  browseModels,
  indexModelCatalog,
  readErrorMessage,
  type HerculeClient,
  type ModelBrowserIndex,
  type ModelBrowserQuery,
} from "@hercule/client-core";
import type { ModelCatalogItem, ModelProfile, ModelProfileUpdateInput } from "@hercule/contract";
import { useModelProfileUpdate } from "../../../../app/model-profile-cache";
import { pluginsQuery, providerAccountsQuery } from "../../../../app/queries";
import { ModelBrowserDialog } from "../../../../screens/settings/providers/model-browser";
import { ProviderMark } from "../../../../screens/settings/providers/provider-mark";

/** What the browser holds of the account's catalog: its index, and why the last read failed. */
interface CatalogRead {
  readonly index: ModelBrowserIndex | null;
  readonly failure: string | null;
}

const NO_CATALOG_READ: CatalogRead = { index: null, failure: null };

const START_QUERY: ModelBrowserQuery = { search: "", facets: NO_MODEL_FACETS, sort: "newest" };

/**
 * Reads the account's whole Model Catalog with `providerAccount.readCatalog`
 * and indexes it for the browser, once per read. The catalog is held in this
 * hook's state, not in the query cache, and is gone when the component that
 * calls it unmounts. A read that answers after that is ignored.
 *
 * It reads again when `catalogReadAt` changes, which is how a Refresh that
 * finished shows up. While the new read runs, the models of the last read stay.
 * When a read fails, `failure` says why and the models of the last good read
 * stay.
 */
function useAccountCatalog(
  client: HerculeClient,
  providerAccountId: string,
  catalogReadAt: string | null,
): CatalogRead {
  const [read, setRead] = useState(NO_CATALOG_READ);
  useEffect(() => {
    let wanted = true;
    client.providerAccount.readCatalog({ params: { id: providerAccountId } }).then(
      (catalog) => {
        if (wanted) setRead({ index: indexModelCatalog(catalog.models), failure: null });
      },
      (error: unknown) => {
        if (wanted) setRead((last) => ({ index: last.index, failure: readErrorMessage(error) }));
      },
    );
    return () => {
      wanted = false;
    };
  }, [client, providerAccountId, catalogReadAt]);
  return read;
}

/**
 * Renders the model browser for one account of the open profile and owns
 * what it needs: the catalog read, the search, filters and sort, the tray of
 * picked models, and the save.
 *
 * - Opening it reads the account's whole catalog once (`useAccountCatalog`).
 *   Each keystroke and each facet filters the catalog in this page, with no
 *   request, and closing the dialog drops the catalog.
 * - Refresh calls `providerAccount.refresh`. The catalog is read again when
 *   the account's `catalogReadAt` changes, and the reason the last read
 *   failed (`catalogError`) shows under the head.
 * - A model is picked or put back by pressing its row, or its chip in the
 *   tray. "Add <n> to <profile>" saves the picks as one `modelProfile.update`
 *   at the end of the account's section (`addModelProfileEntries`) and closes
 *   the dialog. When the controller refuses, its message shows in the dialog
 *   and the picks stay.
 *
 * `held` is the slugs the profile's section already has. `addEntries` builds
 * the change that adds models to the end of an account's section of a
 * profile (`addModelProfileEntries`). The page passes it in, so the rules for
 * editing a profile, which the page needs already, load with the page and not
 * a second time with this dialog. `onClose` is called whenever the dialog
 * closes.
 */
export function ModelBrowser({
  client,
  providerAccountId,
  accountName,
  pluginId,
  profileId,
  profileName,
  held,
  addEntries,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly providerAccountId: string;
  readonly accountName: string;
  readonly pluginId: string | null;
  readonly profileId: string;
  readonly profileName: string;
  readonly held: ReadonlySet<string>;
  readonly addEntries: (
    profile: ModelProfile,
    providerAccountId: string,
    models: readonly string[],
  ) => ModelProfileUpdateInput;
  readonly onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const account = useSuspenseQuery(providerAccountsQuery(client)).data.find(
    ({ id }) => id === providerAccountId,
  );
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const catalog = useAccountCatalog(client, providerAccountId, account?.catalogReadAt ?? null);
  const queryClient = useQueryClient();
  // The picker has the same mutation (`-models-picker.tsx`). A hook that both
  // import would be a chunk of its own, which the Providers page loads and the
  // first screen lists in its preload map, and the first screen is held to its
  // size (spec 17 section Measured).
  const refresh = useMutation({
    mutationFn: () => client.providerAccount.refresh({ params: { id: providerAccountId } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(providerAccountsQuery(client).queryKey, (list) =>
        list?.map((each) => (each.id === updated.id ? updated : each)),
      );
    },
  });
  const save = useModelProfileUpdate(client);
  const [query, setQuery] = useState(START_QUERY);
  const [picks, setPicks] = useState<readonly ModelCatalogItem[]>([]);

  // The same array until the query or the catalog changes, so the table scrolls to the top only then.
  const models = useMemo(
    () => (catalog.index === null ? [] : browseModels(catalog.index, query)),
    [catalog.index, query],
  );
  // A model the profile gained since it was picked is not added twice.
  const toAdd = picks.filter(({ slug }) => !held.has(slug));
  // Before the first read answers, its failure stands in the list. Later ones show under the head.
  const readFailure = catalog.index === null ? null : catalog.failure;
  const readError = refresh.isError
    ? readErrorMessage(refresh.error)
    : (readFailure ?? account?.catalogError ?? null);

  return (
    <ModelBrowserDialog
      dialogRef={dialogRef}
      accountName={accountName}
      mark={<ProviderMark pluginId={pluginId} plugins={plugins} size={16} />}
      profileName={profileName}
      status={catalog.index !== null ? "ready" : catalog.failure === null ? "loading" : "failed"}
      failure={catalog.failure}
      readAt={account?.catalogReadAt ?? null}
      readError={readError}
      refreshing={refresh.isPending}
      makers={catalog.index?.makers ?? []}
      query={query}
      models={models}
      held={held}
      picks={toAdd}
      saving={save.isPending}
      saveError={save.isError ? readErrorMessage(save.error) : null}
      onQueryChange={setQuery}
      onTogglePick={(model) => {
        setPicks((current) =>
          current.some(({ slug }) => slug === model.slug)
            ? current.filter(({ slug }) => slug !== model.slug)
            : [...current, model],
        );
      }}
      onRefresh={() => {
        refresh.mutate();
      }}
      onSave={() => {
        save.mutate(
          {
            profileId,
            buildChange: (current) =>
              addEntries(
                current,
                providerAccountId,
                toAdd.map(({ slug }) => slug),
              ),
          },
          {
            // The dialog closes itself, which calls `onClose`.
            onSuccess: () => dialogRef.current?.close(),
          },
        );
      }}
      onClose={onClose}
    />
  );
}
