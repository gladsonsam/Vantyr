import { useState } from "react";
import { ChevronRight, Globe, Trash2, X } from "lucide-react";
import { DNS_LIMITS, validateDnsCatalog, type DnsFieldError } from "@/api/dnsManagementValidation";
import type {
  DnsDesiredView,
  DnsOperation,
  DnsServiceCatalog,
  DnsServiceDefinition,
  DnsServiceDomain,
} from "@/api/types";
import { HelpTip } from "@/components/common/HelpTip";
import { SettingsSection } from "@/features/network/components/SettingsSection";
import { HoldAction } from "@/features/network/gateways/HoldAction";
import { FormDialog } from "@/features/network/household/FormDialog";
import { Button } from "@vantyr/ui/components/button";
import { Checkbox } from "@vantyr/ui/components/checkbox";
import { Input } from "@vantyr/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vantyr/ui/components/select";
import { DnsBasisGuard, Field } from "./dnsManagementShared";
import { usePinnedBasis } from "./dnsEditor";
import { errorAt, type DnsEditor } from "./dnsEditor";

const CATALOG_HELP =
  "This is a catalog of domains that you define. Vantyr ships no list of apps or sites. Blocking domains cannot prove which app is making a request, and it does not block every request an app makes (other domains, CDNs, or apps that use their own DNS).";

const DEFAULT_CATALOG_VERSION = "1";

interface ServiceDraft {
  id: string;
  label: string;
  version: string;
  domains: DnsServiceDomain[];
  source: string;
  evidence: string;
  license: string;
}

const EMPTY_SERVICE: ServiceDraft = {
  id: "",
  label: "",
  version: "1",
  domains: [{ type: "suffix", value: "" }],
  source: "",
  evidence: "",
  license: "",
};

function draftOf(svc: DnsServiceDefinition): ServiceDraft {
  return {
    id: svc.id,
    label: svc.label,
    version: svc.version,
    domains: svc.domains.map((d) => ({ ...d })),
    source: svc.source ?? "",
    evidence: svc.evidence ?? "",
    license: svc.license ?? "",
  };
}

function serviceOf(d: ServiceDraft): DnsServiceDefinition {
  const opt = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    id: d.id.trim(),
    label: d.label.trim(),
    version: d.version.trim(),
    domains: d.domains.map((x) => ({ type: x.type, value: x.value.trim() })),
    source: opt(d.source),
    evidence: opt(d.evidence),
    license: opt(d.license),
  };
}

/** Catalog edits are always an explicit `set_catalog` of the whole catalog (never a snapshot of other config). */
function catalogWith(
  base: DnsServiceCatalog | null,
  mutate: (services: DnsServiceDefinition[]) => DnsServiceDefinition[],
): DnsServiceCatalog {
  return {
    version: base?.version ?? DEFAULT_CATALOG_VERSION,
    services: mutate(base?.services ?? []),
  };
}

function ServiceFormFields({
  draft,
  setDraft,
  errors,
  mode,
}: {
  draft: ServiceDraft;
  setDraft: (next: ServiceDraft) => void;
  errors: DnsFieldError[];
  mode: "add" | "edit";
}) {
  const set = <K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]) =>
    setDraft({ ...draft, [key]: value });
  const err = (key: string) => errorAt(errors, `catalog.services[0].${key}`);
  const show = (key: string, value: string) => (value.length > 0 ? err(key) : null);
  const setDomain = (i: number, next: DnsServiceDomain) =>
    set(
      "domains",
      draft.domains.map((d, j) => (j === i ? next : d)),
    );
  const domainsError = err("domains");
  return (
    <div className="grid max-h-[60vh] gap-4 overflow-y-auto pr-1">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Id"
          id={`${mode}-svc-id`}
          error={show("id", draft.id)}
          hint={mode === "edit" ? "The id cannot be changed." : "Letters, digits, _ and -."}
        >
          <Input
            id={`${mode}-svc-id`}
            value={draft.id}
            disabled={mode === "edit"}
            maxLength={DNS_LIMITS.maxSourceIdLen}
            onChange={(e) => set("id", e.target.value)}
          />
        </Field>
        <Field label="Label" id={`${mode}-svc-label`} error={show("label", draft.label)}>
          <Input
            id={`${mode}-svc-label`}
            value={draft.label}
            onChange={(e) => set("label", e.target.value)}
          />
        </Field>
      </div>
      <Field
        label="Version"
        id={`${mode}-svc-version`}
        error={show("version", draft.version)}
        hint="Your own revision marker for this definition."
      >
        <Input
          id={`${mode}-svc-version`}
          value={draft.version}
          onChange={(e) => set("version", e.target.value)}
        />
      </Field>
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          Domains
          <HelpTip label="About domain types">
            Suffix blocks the domain and all of its subdomains. Exact blocks only that name. Enter
            hostnames such as example.com, with no URL, path or wildcard.
          </HelpTip>
        </div>
        {draft.domains.map((d, i) => {
          const msg = d.value.length > 0 ? err(`domains[${i}].value`) : null;
          return (
            <div key={i} className="space-y-1">
              <div className="flex gap-2">
                <Select
                  value={d.type}
                  onValueChange={(v) =>
                    setDomain(i, { type: v as DnsServiceDomain["type"], value: d.value })
                  }
                >
                  <SelectTrigger aria-label={`Domain ${i + 1} type`} className="w-36 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="suffix">Suffix</SelectItem>
                    <SelectItem value="exact">Exact</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  aria-label={`Domain ${i + 1}`}
                  value={d.value}
                  placeholder="example.com"
                  onChange={(e) => setDomain(i, { type: d.type, value: e.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove domain ${i + 1}`}
                  disabled={draft.domains.length <= 1}
                  onClick={() =>
                    set(
                      "domains",
                      draft.domains.filter((_, j) => j !== i),
                    )
                  }
                >
                  <X />
                </Button>
              </div>
              {msg ? (
                <p role="alert" className="text-xs text-destructive">
                  {msg}
                </p>
              ) : null}
            </div>
          );
        })}
        {domainsError ? (
          <p role="alert" className="text-xs text-destructive">
            {domainsError}
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={draft.domains.length >= DNS_LIMITS.maxServiceDomains}
          onClick={() => set("domains", [...draft.domains, { type: "suffix", value: "" }])}
        >
          Add domain
        </Button>
      </div>
      <Field
        label="Source (optional)"
        id={`${mode}-svc-source`}
        error={err("source")}
        hint="Where you got these domains."
      >
        <Input
          id={`${mode}-svc-source`}
          value={draft.source}
          maxLength={DNS_LIMITS.maxFieldLen}
          onChange={(e) => set("source", e.target.value)}
        />
      </Field>
      <Field label="Evidence (optional)" id={`${mode}-svc-evidence`} error={err("evidence")}>
        <Input
          id={`${mode}-svc-evidence`}
          value={draft.evidence}
          maxLength={DNS_LIMITS.maxFieldLen}
          onChange={(e) => set("evidence", e.target.value)}
        />
      </Field>
      <Field label="Licence (optional)" id={`${mode}-svc-license`} error={err("license")}>
        <Input
          id={`${mode}-svc-license`}
          value={draft.license}
          maxLength={DNS_LIMITS.maxFieldLen}
          onChange={(e) => set("license", e.target.value)}
        />
      </Field>
    </div>
  );
}

function ServiceDialog({
  editor,
  desired,
  service,
}: {
  editor: DnsEditor;
  desired: DnsDesiredView | null;
  service?: DnsServiceDefinition;
}) {
  const mode = service ? "edit" : "add";
  const [draft, setDraft] = useState<ServiceDraft>(() =>
    service ? draftOf(service) : EMPTY_SERVICE,
  );
  const { pinned, basis, stale, pin } = usePinnedBasis(desired, editor);
  // Everything below derives from the snapshot the dialog opened with (full set_catalog is built from it).
  const catalog = pinned?.config.catalog ?? null;
  const selected = pinned?.config.selected_services ?? [];
  const next = serviceOf(draft);
  const errors = validateDnsCatalog({
    version: catalog?.version ?? DEFAULT_CATALOG_VERSION,
    services: [next],
  });
  if (!service && catalog?.services.some((s) => s.id === next.id)) {
    errors.push({
      path: "catalog.services[0].id",
      message: "A service with this id already exists",
    });
  }
  const [removeError, setRemoveError] = useState<string | null>(null);
  const count = catalog?.services.length ?? 0;
  const full = !service && count >= DNS_LIMITS.maxServices;

  const removeOps = (): DnsOperation[] => {
    const ops: DnsOperation[] = [
      {
        op: "set_catalog",
        catalog: catalogWith(catalog, (all) => all.filter((s) => s.id !== service!.id)),
      },
    ];
    // A selected definition cannot disappear on its own: unselect it in the same atomic batch.
    if (selected.includes(service!.id)) {
      ops.push({ op: "select_services", ids: selected.filter((id) => id !== service!.id) });
    }
    return ops;
  };

  return (
    <FormDialog
      edit={mode === "edit"}
      trigger={mode === "edit" ? "Edit" : "Add service"}
      title={service ? `Edit ${service.label}` : "Define a service"}
      description="Domains you choose to block. This is your own definition; Vantyr does not verify it."
      submitLabel={service ? "Save" : "Add service"}
      canSubmit={errors.length === 0 && !stale}
      disabledReason={full ? `At most ${DNS_LIMITS.maxServices} services are allowed.` : undefined}
      onSubmit={async () => {
        const result = await editor.submit(
          [
            {
              op: "set_catalog",
              catalog: catalogWith(catalog, (all) =>
                service ? all.map((s) => (s.id === service.id ? next : s)) : [...all, next],
              ),
            },
          ],
          basis,
        );
        return result.changed ? undefined : { notice: "No changes" };
      }}
      onReset={() => setDraft(service ? draftOf(service) : EMPTY_SERVICE)}
      footerExtra={
        service ? (
          <div className="space-y-2 border-t border-border/50 pt-3">
            <HoldAction
              ariaLabel={`Hold to remove ${service.label}`}
              doneLabel="Removing"
              icon={<Trash2 />}
              disabled={stale}
              onHold={() => {
                setRemoveError(null);
                editor.submit(removeOps(), basis).catch((e: unknown) => {
                  setRemoveError(e instanceof Error ? e.message : "Request failed");
                });
              }}
            >
              Hold to remove
            </HoldAction>
            {removeError ? (
              <p role="alert" className="text-sm text-destructive">
                {removeError}
              </p>
            ) : null}
            {selected.includes(service.id) ? (
              <p className="text-xs text-muted-foreground">
                This service is selected for blocking. Removing it also unselects it, saved together
                in one change.
              </p>
            ) : null}
          </div>
        ) : null
      }
    >
      <DnsBasisGuard
        stale={stale}
        onOpen={() => {
          pin();
          setDraft(service ? draftOf(service) : EMPTY_SERVICE);
        }}
        onReload={editor.reload}
      />
      <ServiceFormFields draft={draft} setDraft={setDraft} errors={errors} mode={mode} />
    </FormDialog>
  );
}

function ServiceRow({
  service,
  checked,
  editor,
  desired,
  onToggle,
}: {
  service: DnsServiceDefinition;
  checked: boolean;
  editor: DnsEditor;
  desired: DnsDesiredView;
  onToggle: (checked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const detailId = `svc-detail-${service.id}`;
  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Checkbox
            aria-label={`Block ${service.label}`}
            className="mt-0.5"
            checked={checked}
            disabled={editor.busy || editor.conflict}
            onCheckedChange={(c) => onToggle(c === true)}
          />
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium">{service.label}</div>
            <div className="text-[0.8125rem] text-muted-foreground">
              {service.id} · version {service.version} · {service.domains.length}{" "}
              {service.domains.length === 1 ? "domain" : "domains"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronRight className={`transition-transform ${open ? "rotate-90" : ""}`} /> Domains
          </Button>
          <ServiceDialog key={service.id} editor={editor} desired={desired} service={service} />
        </div>
      </div>
      {open ? (
        <div id={detailId} className="mt-3 space-y-2 pl-7 text-[0.8125rem]">
          <ul className="space-y-0.5 font-mono text-xs">
            {service.domains.map((d, i) => (
              <li key={i}>
                <span className="inline-block w-14 font-sans text-muted-foreground">{d.type}</span>
                {d.value}
              </li>
            ))}
          </ul>
          {service.source || service.evidence || service.license ? (
            <dl className="space-y-0.5 text-muted-foreground">
              {service.source ? <div>Source: {service.source}</div> : null}
              {service.evidence ? <div>Evidence: {service.evidence}</div> : null}
              {service.license ? <div>Licence: {service.license}</div> : null}
              <div>Declared by the operator, not verified.</div>
            </dl>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CatalogVersionDialog({
  editor,
  desired,
  catalog: latestCatalog,
}: {
  editor: DnsEditor;
  desired: DnsDesiredView | null;
  catalog: DnsServiceCatalog;
}) {
  const [version, setVersion] = useState(latestCatalog.version);
  const { pinned, basis, stale, pin } = usePinnedBasis(desired, editor);
  // The whole catalog is resubmitted, so it must be the one the dialog opened with.
  const catalog = pinned?.config.catalog ?? latestCatalog;
  const trimmed = version.trim();
  const message =
    validateDnsCatalog({ version: trimmed, services: [] }).find((e) => e.path === "catalog.version")
      ?.message ?? null;
  return (
    <FormDialog
      edit
      trigger="Edit version"
      title="Catalog version"
      description="Your own revision marker for this set of definitions."
      submitLabel="Save"
      canSubmit={message === null && trimmed !== catalog.version && !stale}
      onSubmit={async () => {
        const result = await editor.submit(
          [{ op: "set_catalog", catalog: { version: trimmed, services: catalog.services } }],
          basis,
        );
        return result.changed ? undefined : { notice: "No changes" };
      }}
      onReset={() => setVersion(latestCatalog.version)}
    >
      <DnsBasisGuard
        stale={stale}
        onOpen={() => {
          pin();
          setVersion(latestCatalog.version);
        }}
        onReload={editor.reload}
      />
      <Field label="Version" id="catalog-version" error={message}>
        <Input id="catalog-version" value={version} onChange={(e) => setVersion(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

/** Operator-declared service domains and which of them to block. Saved is a proposal, not enforcement. */
export function DnsServicesCard({
  desired,
  editor,
}: {
  desired: DnsDesiredView | null;
  editor: DnsEditor;
}) {
  const services = desired?.config.catalog?.services ?? [];
  const selected = desired?.config.selected_services ?? [];
  const toggle = (id: string, on: boolean) => {
    const ids = on ? [...new Set([...selected, id])] : selected.filter((x) => x !== id);
    void editor.run([{ op: "select_services", ids }], desired?.config_version ?? 0);
  };
  return (
    <SettingsSection
      title="Blocked services"
      icon={<Globe />}
      help={CATALOG_HELP}
      action={<ServiceDialog editor={editor} desired={desired} />}
    >
      {services.length === 0 || !desired ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          No services defined. Define the domains of an app or site you want to block; Vantyr does
          not ship a list.
        </p>
      ) : (
        services.map((service) => (
          <ServiceRow
            key={service.id}
            service={service}
            checked={selected.includes(service.id)}
            editor={editor}
            desired={desired}
            onToggle={(on) => toggle(service.id, on)}
          />
        ))
      )}
      {desired?.config.catalog && services.length > 0 ? (
        <div className="flex items-center justify-between gap-3 px-5 py-3 text-[0.8125rem] text-muted-foreground">
          <span>Catalog version {desired.config.catalog.version}</span>
          <CatalogVersionDialog
            editor={editor}
            desired={desired}
            catalog={desired.config.catalog}
          />
        </div>
      ) : null}
    </SettingsSection>
  );
}
