import { describe, it, expect } from "vitest";
import { toPublicPersistence, renderPersistencePage } from "../src/persistencePublic.js";
import { computePersistence } from "../src/attestation/persistence.js";
import type { DecodedSignalAttestation } from "../src/attestation/queryAttestations.js";

const HOUR = 3600;
const T0 = 1_753_000_000;

function att(o: Partial<DecodedSignalAttestation> & { time: number }): DecodedSignalAttestation {
  return {
    uid: `0x${o.time.toString(16).padStart(64, "0")}` as `0x${string}`,
    attester: "0x561143BFE9E2D975D92e915B8EfFEAa54119472a",
    asset: "USDC",
    bestProtocol: "aave",
    weightedApyBps: 500,
    gapBps: 40,
    asOf: o.time,
    runnerUpProtocol: null,
    runnerUpWeightedApyBps: null,
    coverage: null,
    ...o,
  };
}

const META = {
  schemaUid: "0xe74a27f6c216134a1a3aef4c26e29bd8866ac679a8023ddde34faa0bb05dd272",
  attester: "0x561143BFE9E2D975D92e915B8EfFEAa54119472a",
  paidRoutes: ["/persistence/usdc-base-yield"],
};

/** Série com líder que muda, terminando em "moonwell" — o valor que NÃO pode vazar. */
const serie = ["aave", "compound", "aave", "compound", "aave", "compound", "moonwell"].map((p, i) =>
  att({ time: T0 + i * HOUR, bestProtocol: p as DecodedSignalAttestation["bestProtocol"] }),
);

describe("recorte público da persistência", () => {
  const relatorio = computePersistence(serie);
  const publico = toPublicPersistence(relatorio, META);
  const serializado = JSON.stringify(publico);

  it("NÃO expõe quem lidera agora — é a resposta que /signal vende", () => {
    // O teste que justifica o arquivo: um artefato de divulgação que entrega o
    // produto de graça canibaliza o catálogo que ele existe pra divulgar.
    expect(relatorio.perAsset[0].currentProtocol).toBe("moonwell");
    expect(serializado).not.toContain("moonwell");
    expect(serializado).not.toContain("currentProtocol");
  });

  it("NÃO expõe há quanto tempo a liderança corrente dura", () => {
    expect(serializado).not.toContain("currentLeadHours");
  });

  it("NÃO expõe expectedLeadHours — a peça que o /decision consome", () => {
    expect(relatorio.perAsset[0].expectedLeadHours).not.toBeNull();
    expect(serializado).not.toContain("expectedLeadHours");
  });

  it("NÃO expõe o valor do edge por US$10k", () => {
    expect(serializado).not.toContain("edgeValueUsdPer10k");
  });

  it("expõe SIM o histórico agregado — é a prova, e prova atrás de paywall não prova nada", () => {
    const a = publico.perAsset[0];
    expect(a.medianLeadHours).toBe(1);
    expect(a.closedSpells).toBe(6);
    expect(a.survival.length).toBeGreaterThan(0);
    expect(a.roundTripShare).not.toBeNull();
    expect(publico.attestationsInWindow).toBe(7);
  });

  it("expõe o achado do gap por inteiro — é o material citável", () => {
    expect(publico.gapVsDuration).toEqual(relatorio.gapVsDuration);
  });

  it("diz como reproduzir sem confiar no servidor", () => {
    expect(publico.reproduce.source).toContain("easscan.org");
    expect(publico.reproduce.attester).toBe(META.attester);
    expect(publico.reproduce.schemaUid).toBe(META.schemaUid);
  });

  it("aponta quais rotas são pagas, com o que elas acrescentam", () => {
    expect(publico.paidDetail.routes).toEqual(META.paidRoutes);
    expect(publico.paidDetail.note.toLowerCase()).toContain("right now");
  });

  it("liderança em aberto vira sinalizador, não uma duração inventada", () => {
    const so = ["euler", "euler", "euler"].map((p, i) =>
      att({ time: T0 + i * HOUR, bestProtocol: p as DecodedSignalAttestation["bestProtocol"], asset: "WETH" }),
    );
    const pub = toPublicPersistence(computePersistence(so), META);
    expect(pub.perAsset[0].leadStillOpen).toBe(true);
    expect(pub.perAsset[0].medianLeadHours).toBeNull();
    expect(JSON.stringify(pub)).not.toContain("euler");
  });
});

describe("página pública", () => {
  const publico = toPublicPersistence(computePersistence(serie), META);

  it("renderiza sem vazar o líder atual", () => {
    const html = renderPersistencePage(publico);
    expect(html).not.toContain("moonwell");
    expect(html).toContain("How long does a yield signal stay true");
  });

  it("declara-se como Dataset em JSON-LD — é o que faz buscador de dado indexar", () => {
    const html = renderPersistencePage(publico);
    const bloco = html.match(/<script type="application\/ld\+json">(.+?)<\/script>/s);
    expect(bloco).not.toBeNull();
    const jsonld = JSON.parse((bloco as RegExpMatchArray)[1]);
    expect(jsonld["@type"]).toBe("Dataset");
    expect(jsonld.isAccessibleForFree).toBe(true);
    expect(jsonld.distribution[0].contentUrl).toContain("/persistence.json");
  });

  it("sem dado, serve página explicando em vez de 5xx ou número velho", () => {
    const html = renderPersistencePage(null);
    expect(html).toContain("could not be read");
    expect(html).toContain("/persistence.json");
  });

  it("escapa conteúdo interpolado", () => {
    const sujo = { ...publico, reproduce: { ...publico.reproduce, attester: '"><script>alert(1)</script>' } };
    const html = renderPersistencePage(sujo);
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
