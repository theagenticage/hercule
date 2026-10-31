import { useMemo, useRef, useState, type JSX } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  NO_MODEL_FACETS,
  browseModels,
  indexModelCatalog,
  readErrorMessage,
  type HerculeClient,
  type ModelBrowserIndex,
  type ModelBrowserQuery,
} from "@hercule/client-core";
import type {
  ModelCatalog,
  ModelCatalogItem,
  ModelProfile,
  ModelProfileUpdateInput,
} from "@hercule/contract";
import { useModelProfileUpdate } from "../../../../app/model-profile-cache";
import { pluginsQuery, providerAccountsQuery } from "../../../../app/queries";
import { accountCatalogQuery } from "./-account-catalog-query";
import { ModelBrowserDialog } from "../../../../screens/settings/providers/model-browser";
import { ProviderMark } from "../../../../screens/settings/providers/provider-mark";

const START_QUERY: ModelBrowserQuery = { search: "", facets: NO_MODEL_FACETS, sort: "newest" };

/**
 * Indexes a catalog for the browser. The same function every time, so the
 * query runs it once per answer, not once per render.
 */
const indexCatalog = (catalog: ModelCatalog): ModelBrowserIndex =>
  indexModelCatalog(catalog.models);

/**
 * Renders the model browser for one account of the open profile and owns
 * what it needs: the catalog read, the search, filters and sort, the tray of
 * picked models, and the save.
 *
 * - Opening it reads the account's whole catalog once, as the picker does
 *   (`accountCatalogQuery`), and indexes it once per read. Each keystroke and
 *   each facet filters the catalog in this page, with no request. The query
 *   is removed when the dialog closes, and a read that answers after that, or
 *   after a newer one, is never shown.
 * - Refresh calls `providerAccount.refresh`. The catalog is read again when
 *   the account's `catalogReadAt` changes, and the models of the last read
 *   stay while it runs. The reason the last refresh failed (`catalogError`)
 *   shows under the head. When a read itself fails, the list says why.
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
  const catalog = useQuery({
    ...accountCatalogQuery(client, providerAccountId, account?.catalogReadAt ?? null),
    select: indexCatalog,
    placeholderData: keepPreviousData,
  });
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
    () => (catalog.data === undefined ? [] : browseModels(catalog.data, query)),
    [catalog.data, query],
  );
  // A model the profile gained since it was picked is not added twice.
  const toAdd = picks.filter(({ slug }) => !held.has(slug));
  const readError = refresh.isError
    ? readErrorMessage(refresh.error)
    : (account?.catalogError ?? null);

  return (
    <ModelBrowserDialog
      dialogRef={dialogRef}
      accountName={accountName}
      mark={<ProviderMark pluginId={pluginId} plugins={plugins} size={16} />}
      profileName={profileName}
      status={catalog.isError ? "failed" : catalog.isPending ? "loading" : "ready"}
      failure={catalog.isError ? readErrorMessage(catalog.error) : null}
      readAt={account?.catalogReadAt ?? null}
      readError={readError}
      refreshing={refresh.isPending}
      makers={catalog.data?.makers ?? []}
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
