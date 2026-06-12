export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { token, baseUrl, groupId, userId, intervaloIso } = req.body;
  if (!token || !groupId || !intervaloIso) {
    return res.status(200).json({ erro: 'Equipe de trabalho e Período são obrigatórios.' });
  }

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');
  const TOLERANCIA_GERAL_MS = 2 * 60000; // 2 minutos de tolerância fixa

  try {
    // 1. Carregar dicionário de presenças do Genesys
    const dicPresencas = {};
    const resPres = await fetch(`${cleanUrl}/api/v2/presencedefinitions?pageSize=100`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (resPres.ok) {
      const dataPres = await resPres.json();
      if (dataPres.entities) {
        dataPres.entities.forEach(p => {
          dicPresencas[p.id] = (p.languageLabels && (p.languageLabels["pt-BR"] || p.languageLabels["pt_BR"])) || p.name;
        });
      }
    }
    const traducoesPadrao = { "ON_QUEUE": "Fila", "AVAILABLE": "Disponível", "AWAY": "Ausente", "BREAK": "Pausa Auricular", "MEAL": "Refeição", "MEETING": "Reunião", "TRAINING": "Treinamento", "BUSY": "Ocupado" };

    // 2. BUSCA O CADASTRO COMPLETO DA EQUIPE (Para garantir que ninguém suma)
    let mapeamentoEquipeCompleta = [];
    if (userId) {
      // Se selecionou um agente único
      try {
        const rSingle = await fetch(`${cleanUrl}/api/v2/users/${userId}`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (rSingle.ok) {
          const dSingle = await rSingle.json();
          mapeamentoEquipeCompleta.push({ id: dSingle.id, nome: dSingle.name });
        }
      } catch {}
    } else {
      // Puxa todos os integrantes da equipe selecionada
      const resGrupo = await fetch(`${cleanUrl}/api/v2/teams/${groupId}/members?pageSize=100`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      if (resGrupo.ok) {
        const dGrupo = await resGrupo.json();
        if (dGrupo.entities) {
          mapeamentoEquipeCompleta = dGrupo.entities.map(m => ({ id: m.id, nome: m.name }));
        }
      }
    }

    if (mapeamentoEquipeCompleta.length === 0) {
      return res.status(200).json({ ok: true, dados: [] });
    }

    // 3. Consulta a Timeline de estados no Analytics para os usuários filtrados
    const payloadWfm = {
      "interval": intervaloIso,
      "userFilters": [{ "type": "or", "predicates": mapeamentoEquipeCompleta.map(m => ({ "dimension": "userId", "value": m.id })) }]
    };

    const resQuery = await fetch(`${cleanUrl}/api/v2/analytics/users/details/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadWfm)
    });

    const dataQuery = await resQuery.json();
    
    // Mapeia os históricos retornados organizados por ID de Usuário
    let timelinePorUsuario = {};
    if (resQuery.ok && dataQuery.userDetails) {
      dataQuery.userDetails.forEach(u => {
        let historicoPausas = [];
        let totalEstouros = 0;

        if (u.primaryPresence) {
          u.primaryPresence.forEach(pres => {
            let pDefId = pres.presenceDefinitionId;
            let nomeStatus = dicPresencas[pDefId] || traducoesPadrao[pres.systemPresence] || pres.systemPresence;
            
            if (pres.systemPresence !== "AVAILABLE" && pres.systemPresence !== "OFFLINE" && pres.systemPresence !== "ON_QUEUE") {
              let inicio = new Date(pres.startTime);
              let fim = pres.endTime ? new Date(pres.endTime) : new Date();
              let duracaoMs = fim.getTime() - inicio.getTime();

              if (duracaoMs > 0) {
                let tempoTotalMin = Math.floor(duracaoMs / 60000);
                let estourou = false;
                let tempoEstouroMin = 0;

                let sysUpper = pres.systemPresence.toUpperCase();
                let nomeUpper = nomeStatus.toUpperCase();

                // Aplicação da regra rígida WFM de estouro (10m e 20m + 2m tolerância)
                if (sysUpper === "BREAK" || nomeUpper.includes("AURICULAR") || nomeUpper.includes("PAUSA 10")) {
                  if (duracaoMs > (10 * 60000) + TOLERANCIA_GERAL_MS) {
                    estourou = true;
                    tempoEstouroMin = Math.floor((duracaoMs - (10 * 60000)) / 60000);
                    totalEstourosAgente++;
                  }
                } else if (sysUpper === "MEAL" || nomeUpper.includes("REFEIÇÃO") || nomeUpper.includes("ALMOÇO")) {
                  if (duracaoMs > (20 * 60000) + TOLERANCIA_GERAL_MS) {
                    estourou = true;
                    tempoEstouroMin = Math.floor((duracaoMs - (20 * 60000)) / 60000);
                    totalEstourosAgente++;
                  }
                }

                historicoPausas.push({
                  status: nomeStatus,
                  inicio: inicio.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
                  fim: pres.endTime ? fim.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : "Ainda em Pausa",
                  tempoTotalMin: tempoTotalMin,
                  estourou: estourou,
                  tempoEstouroMin: tempoEstouroMin
                });
              }
            }
          });
        }
        
        timelinePorUsuario[u.userId] = { pausas: historicoPausas };
      });
    }

    // 4. ALINHAMENTO FINAL (Garante 100% da equipe unificada na tabela)
    let resultadoFinal = mapeamentoEquipeCompleta.map(agenteCadastro => {
      let dadosTimeline = timelinePorUsuario[agenteCadastro.id] || { pausas: [] };
      let listaDePausas = dadosTimeline.pausas;
      let totalEstouros = listaDePausas.filter(p => p.estourou).length;

      return {
        userId: agenteCadastro.id,
        nome: agenteCadastro.nome,
        pausas: listaDePausas, // Histórico completo do dia de trabalho
        totalEstourosNoPeriodo: totalEstouros
      };
    });

    // Ordenação inteligente: Quem tem estouros graves WFM sobe; quem trabalhou certinho fica logo abaixo em ordem alfabética
    resultadoFinal.sort((a, b) => {
      if (b.totalEstourosNoPeriodo !== a.totalEstourosNoPeriodo) {
        return b.totalEstourosNoPeriodo - a.totalEstourosNoPeriodo;
      }
      return a.nome.localeCompare(b.nome);
    });

    return res.status(200).json({ ok: true, dados: resultadoFinal });

  } catch (e) {
    return res.status(200).json({ erro: 'Erro Crítico no WFM: ' + e.message });
  }
}
