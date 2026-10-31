import { useState, type JSX } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  opensModelBrowser,
  readErrorMessage,
  searchPickerModels,
  type HerculeClient,
} from "@hercule/client-core";
import { providerAccountsQuery } from "../../../../app/queries";
import {
  AddModelPopover,
  BrowseModelsButton,
  ModelPicker,
} from "../../../../screens/settings/providers/model-picker";

/**
 * Renders an account's "Add a model" button and the picker it opens, over the
 * account's Model Catalog (`providerAccount.readCatalog`). An account whose
 * catalog has more than 40 models (`modelCount`) gets "Browse <n> models"
 * instead, and the picker of a smaller one ends in "Browse all <n>". Both
 * call `onBrowse`, which opens the model browser; the caller owns it.
 *
 * The catalog is read when the picker opens and lives in the picker alone: it
 * is a query that is removed the moment the picker closes, and it is not one
 * the live connection keeps current. It is read again when the account's
 * `catalogReadAt` changes, which is how a Refresh that finished shows up.
 * Refresh (`providerAccount.refresh`) answers at once and the read follows on
 * its own, so the button is busy only while the request runs.
 *
 * `held` is the slugs the profile's section has, and `onToggle` adds the model
 * to the section or takes it out.
 */
export function AccountModelPicker({
  client,
  providerAccountId,
  name,
  modelCount,
  held,
  onToggle,
  onBrowse,
}: {
  readonly client: HerculeClient;
  readonly providerAccountId: string;
  readonly name: string;
  readonly modelCount: number;
  readonly held: ReadonlySet<string>;
  readonly onToggle: (slug: string) => void;
  readonly onBrowse: () => void;
}): JSX.Element {
  if (opensModelBrowser(modelCount)) {
    return <BrowseModelsButton name={name} modelCount={modelCount} onBrowse={onBrowse} />;
  }
  return (
    <AddModelPopover name={name} browseAll={modelCount > 0 ? { modelCount, onBrowse } : undefined}>
      <OpenPicker
        client={client}
        providerAccountId={providerAccountId}
        held={held}
        onToggle={onToggle}
      />
    </AddModelPopover>
  );
}

/** Renders the open picker. It exists only while the popover is open, so it reads the catalog on opening and drops it on closing. */
function OpenPicker({
  client,
  providerAccountId,
  held,
  onToggle,
}: {
  readonly client: HerculeClient;
  readonly providerAccountId: string;
  readonly held: ReadonlySet<string>;
  readonly onToggle: (slug: string) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const account = accounts.find(({ id }) => id === providerAccountId);
  const [query, setQuery] = useState("");

  const catalog = useQuery({
    queryKey: ["model-catalog", providerAccountId, account?.catalogReadAt ?? null],
    queryFn: () => client.providerAccount.readCatalog({ params: { id: providerAccountId } }),
    // Gone when the picker closes, and never refetched behind the user's back.
    gcTime: 0,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  // The model browser has its own copy of this mutation (`-model-browser.tsx`).
  const refresh = useMutation({
    mutationFn: () => client.providerAccount.refresh({ params: { id: providerAccountId } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(providerAccountsQuery(client).queryKey, (list) =>
        list?.map((each) => (each.id === updated.id ? updated : each)),
      );
    },
  });

  const { models, hiddenCount } = searchPickerModels(catalog.data?.models ?? [], query);
  return (
    <ModelPicker
      status={catalog.isError ? "failed" : catalog.isPending ? "loading" : "ready"}
      failure={catalog.isError ? readErrorMessage(catalog.error) : null}
      readAt={account?.catalogReadAt ?? null}
      readError={
        refresh.isError ? readErrorMessage(refresh.error) : (account?.catalogError ?? null)
      }
      models={models}
      hiddenCount={hiddenCount}
      query={query}
      held={held}
      refreshing={refresh.isPending}
      onQueryChange={setQuery}
      onToggle={onToggle}
      onRefresh={() => {
        refresh.mutate();
      }}
    />
  );
}
