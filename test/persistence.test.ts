import { describe, it, expect } from "vitest";
import {
  buildSpells,
  computeGapVsDuration,
  computePersistence,
  leadHoursForDecision,
  spearman,
  MIN_CLOSED_SPELLS,
} from "../src/attestation/persistence.js";
import type { DecodedSignalAttestation } from "../src/attestation/queryAttestations.js";

const HOUR = 3600;
const T0 = 1_753_000_000; // instante unix fixo — nada aqui depende do relógio real

function att(
  overrides: Partial<DecodedSignalAttestation> & { time: number },
): DecodedSignalAttestation {
  return {
    uid: `0x${overrides.time.toString(16).padStart(64, "0")}` as `0x${string}`,
    attester: "0x561143BFE9E2D975D92e915B8EfFEAa54119472a",
    asset: "USDC",
    bestProtocol: "aave",
    weightedApyBps: 500,
    gapBps: 40,
    asOf: overrides.time,
    runnerUpProtocol: null,
    runnerUpWeightedApyBps: null,
    coverage: null,
    ...overrides,
  };
}

/** Sequência de líderes em cadência horária — atalho pros casos longos. */
function serie(protocolos: string[], asset = "USDC"): DecodedSignalAttestation[] {
  return protocolos.map((p, i) =>
    att({ time: T0 + i * HOUR, bestProtocol: p as DecodedSignalAttestation["bestProtocol"], asset: asset as DecodedSignalAttestation["asset"] }),
  );
}

describe("buildSpells", () => {
  it("agrupa atestações consecutivas do mesmo líder num só spell", () => {
    const spells = buildSpells(serie(["aave", "aave", "aave", "compound"]));
    expect(spells).toHaveLength(2);
    expect(spells[0]).toMatchObject({ protocol: "aave", observations: 3, hours: 3, closed: true });
    expect(spells[1]).toMatchObject({ protocol: "compound", observations: 1, closed: false });
  });

  it("o spell fecha no instante da atestação que trouxe outro líder", () => {
    const spells = buildSpells(serie(["aave", "compound"]));
    expect(spells[0].endedAt).toBe(new Date((T0 + HOUR) * 1000).toISOString());
    expect(spells[0].hours).toBe(1);
  });

  it("o spell corrente é medido até a ÚLTIMA observação, nunca até o relógio", () => {
    // Se esticasse até "agora", a duração cresceria sozinha entre chamadas e
    // inflaria a durabilidade com tempo que ninguém observou.
    const spells = buildSpells(serie(["aave", "aave"]));
    expect(spells).toHaveLength(1);
    expect(spells[0].closed).toBe(false);
    expect(spells[0].endedAt).toBeNull();
    expect(spells[0].hours).toBe(1);
  });

  it("guarda o gap da atestação que ABRIU o spell, não o da que fechou", () => {
    const spells = buildSpells([
      att({ time: T0, bestProtocol: "aave", gapBps: 300 }),
      att({ time: T0 + HOUR, bestProtocol: "aave", gapBps: 5 }),
      att({ time: T0 + 2 * HOUR, bestProtocol: "compound", gapBps: 12 }),
    ]);
    expect(spells[0].startGapBps).toBe(300);
  });

  it("ordena por instante de mineração, não pela ordem em que a query devolveu", () => {
    // O EASScan devolve `time: desc`; sem reordenar, "o seguinte" seria o anterior.
    const desc = [...serie(["aave", "aave", "compound"])].reverse();
    const spells = buildSpells(desc);
    expect(spells.map((s) => s.protocol)).toEqual(["aave", "compound"]);
    expect(spells[0].hours).toBe(2);
  });

  it("separa os spells por asset — líderes de assets diferentes não se misturam", () => {
    const spells = buildSpells([
      att({ time: T0, asset: "USDC", bestProtocol: "aave" }),
      att({ time: T0 + HOUR, asset: "WETH", bestProtocol: "euler" }),
      att({ time: T0 + 2 * HOUR, asset: "USDC", bestProtocol: "aave" }),
    ]);
    const usdc = spells.filter((s) => s.asset === "USDC");
    expect(usdc).toHaveLength(1);
    expect(usdc[0].hours).toBe(2);
    expect(spells.filter((s) => s.asset === "WETH")).toHaveLength(1);
  });

  it("líder que volta depois de sair conta como spell NOVO, não continuação", () => {
    const spells = buildSpells(serie(["aave", "compound", "aave"]));
    expect(spells).toHaveLength(3);
    expect(spells.map((s) => s.protocol)).toEqual(["aave", "compound", "aave"]);
  });

  it("não quebra com lista vazia", () => {
    expect(buildSpells([])).toEqual([]);
  });
});

describe("amostra insuficiente", () => {
  it("abaixo do mínimo de spells fechados, mediana e sobrevivência são null — nunca um número que finge precisão", () => {
    const rep = computePersistence(serie(["aave", "compound", "aave", "compound"]));
    const usdc = rep.perAsset[0];
    expect(usdc.closedSpells).toBeLessThan(MIN_CLOSED_SPELLS);
    expect(usdc.medianLeadHours).toBeNull();
    expect(usdc.meanLeadHours).toBeNull();
    expect(usdc.survival.every((s) => s.rate === null)).toBe(true);
    expect(usdc.sampleWarning).toContain(`minimum ${MIN_CLOSED_SPELLS}`);
  });

  it("liderança que nunca trocou vira piso declarado, não mediana", () => {
    const rep = computePersistence(serie(["euler", "euler", "euler"], "WETH"));
    const weth = rep.perAsset[0];
    expect(weth.closedSpells).toBe(0);
    expect(weth.medianLeadHours).toBeNull();
    expect(weth.currentLeadCensored).toBe(true);
    expect(weth.currentLeadHours).toBe(2);
    // O piso ainda serve de base pro horizonte do /decision — errar pra menos.
    expect(weth.expectedLeadHours).toBe(2);
    expect(weth.sampleWarning).toContain("floor");
  });

  it("com amostra suficiente, publica mediana e curva de sobrevivência", () => {
    // 6 spells fechados de 1h + 1 aberto.
    const rep = computePersistence(serie(["a", "b", "a", "b", "a", "b", "a"]));
    const usdc = rep.perAsset[0];
    expect(usdc.closedSpells).toBe(6);
    expect(usdc.medianLeadHours).toBe(1);
    expect(usdc.survival.find((s) => s.atLeastHours === 6)?.rate).toBe(0);
  });
});

describe("censura à direita", () => {
  it("liderança corrente mais longa que qualquer encerrada é marcada como censurada", () => {
    // 5 spells de 1h e depois um corrente de 4h.
    const rep = computePersistence(serie(["a", "b", "a", "b", "a", "c", "c", "c", "c", "c"]));
    const usdc = rep.perAsset[0];
    expect(usdc.currentLeadHours).toBe(4);
    expect(usdc.longestClosedLeadHours).toBe(1);
    expect(usdc.currentLeadCensored).toBe(true);
  });

  it("liderança corrente curta perto do histórico NÃO é censurada", () => {
    const rep = computePersistence(serie(["a", "a", "a", "a", "b", "c", "d", "e", "f"]));
    const usdc = rep.perAsset[0];
    expect(usdc.longestClosedLeadHours).toBe(4);
    expect(usdc.currentLeadCensored).toBe(false);
  });
});

describe("spearman", () => {
  it("relação monotônica perfeita dá 1", () => {
    expect(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBe(1);
  });

  it("relação inversa perfeita dá -1", () => {
    expect(spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])).toBe(-1);
  });

  it("empates recebem posto médio — desempatar pela ordem do array inventaria ordenação", () => {
    // y é constante em blocos; sem posto médio o resultado dependeria da ordem.
    const a = spearman([1, 2, 3, 4], [5, 5, 9, 9]);
    const b = spearman([2, 1, 4, 3], [5, 5, 9, 9]);
    expect(a).toBe(b);
  });

  it("série sem variação devolve null em vez de dividir por zero", () => {
    expect(spearman([1, 1, 1, 1], [2, 3, 4, 5])).toBeNull();
  });

  it("amostra menor que 3 devolve null", () => {
    expect(spearman([1, 2], [3, 4])).toBeNull();
  });
});

describe("computeGapVsDuration", () => {
  it("declara que o gap NÃO discrimina quando a correlação é fraca", () => {
    // Gap crescente, durações embaralhadas de propósito.
    const protocolos: string[] = [];
    for (let i = 0; i < 40; i += 1) protocolos.push(i % 2 === 0 ? "a" : "b");
    const atts = protocolos.map((p, i) =>
      att({ time: T0 + i * HOUR, bestProtocol: p as DecodedSignalAttestation["bestProtocol"], gapBps: i * 10 }),
    );
    const res = computeGapVsDuration(buildSpells(atts));
    // Todos os spells duram 1h => duração sem variação => ρ indefinido.
    expect(res.spearman).toBeNull();
    expect(res.discriminates).toBeNull();
    expect(res.note).toContain("not enough");
  });

  it("reconhece quando o gap DE FATO prevê a duração", () => {
    // Construído pra ter relação forte: gap alto => spell longo.
    const atts: DecodedSignalAttestation[] = [];
    let t = T0;
    const duracoes = [1, 2, 3, 4, 5, 6, 7, 8];
    duracoes.forEach((dur, idx) => {
      const proto = idx % 2 === 0 ? "a" : "b";
      for (let h = 0; h < dur; h += 1) {
        atts.push(
          att({
            time: t + h * HOUR,
            bestProtocol: proto as DecodedSignalAttestation["bestProtocol"],
            gapBps: dur * 50,
          }),
        );
      }
      t += dur * HOUR;
    });
    const res = computeGapVsDuration(buildSpells(atts));
    expect(res.spearman).not.toBeNull();
    expect(res.spearman as number).toBeGreaterThan(0.9);
    expect(res.discriminates).toBe(true);
    expect(res.note).toContain("does predict");
  });

  it("faixa com amostra abaixo do mínimo não publica mediana", () => {
    const atts = serie(["a", "b", "a", "b"]).map((a, i) => ({ ...a, gapBps: i === 0 ? 5000 : 10 }));
    const res = computeGapVsDuration(buildSpells(atts));
    const faixaAlta = res.bands.find((b) => b.label === ">=300bps");
    expect(faixaAlta?.spells).toBeLessThan(MIN_CLOSED_SPELLS);
    expect(faixaAlta?.medianLeadHours).toBeNull();
  });
});

describe("valor do edge e vaivém", () => {
  it("o ganho por US$10k sai do gap mediano vezes a duração esperada", () => {
    // 6 spells de 1h, gap fixo em 8760bps => 1h de liderança = US$ 1 por 10k.
    const atts = serie(["a", "b", "a", "b", "a", "b", "a"]).map((a) => ({ ...a, gapBps: 8760 }));
    const usdc = computePersistence(atts).perAsset[0];
    expect(usdc.medianGapBps).toBe(8760);
    expect(usdc.expectedLeadHours).toBe(1);
    expect(usdc.edgeValueUsdPer10k).toBe(1);
  });

  it("mede o vaivém entre o mesmo par nos dois sentidos como uma coisa só", () => {
    const usdc = computePersistence(serie(["a", "b", "a", "b", "a", "b", "a"])).perAsset[0];
    expect(usdc.topSwitchPair).toBe("a <-> b");
    expect(usdc.roundTripShare).toBe(1);
  });

  it("avisa quando a liderança mediana está dentro do dobro da resolução de observação", () => {
    const usdc = computePersistence(serie(["a", "b", "a", "b", "a", "b", "a"])).perAsset[0];
    expect(usdc.observationResolutionHours).toBe(1);
    expect(usdc.sampleWarning).toContain("observation interval");
  });
});

describe("leadHoursForDecision", () => {
  it("devolve a duração esperada do asset pedido", () => {
    const rep = computePersistence(serie(["a", "b", "a", "b", "a", "b", "a"]));
    expect(leadHoursForDecision(rep, "USDC")).toBe(1);
  });

  it("asset ausente do relatório devolve null — sem base, sem desconto inventado", () => {
    const rep = computePersistence(serie(["a", "b", "a", "b", "a", "b", "a"]));
    expect(leadHoursForDecision(rep, "WETH")).toBeNull();
    expect(leadHoursForDecision(null, "USDC")).toBeNull();
  });
});

describe("relatório", () => {
  it("reporta a janela observada a partir das próprias atestações", () => {
    const rep = computePersistence(serie(["a", "a", "a", "a", "a"]));
    expect(rep.totalAttestations).toBe(5);
    expect(rep.observedFrom).toBe(new Date(T0 * 1000).toISOString());
    expect(rep.observedTo).toBe(new Date((T0 + 4 * HOUR) * 1000).toISOString());
    expect(rep.observedDays).toBe(0.17);
  });

  it("lista vazia não quebra e não inventa janela", () => {
    const rep = computePersistence([]);
    expect(rep.perAsset).toEqual([]);
    expect(rep.observedFrom).toBeNull();
    expect(rep.observedDays).toBeNull();
  });
});
