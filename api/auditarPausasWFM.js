export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { token, baseUrl, queueId, toleranciaMinutos } = req.body;
  if (!token || !queueId) return res.status(200).json({ erro: 'Parâmetros ausentes.' });

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');
  const limiteToleranciaMs = (parseInt(toleranciaMinutos) || 15) * 60000;

  try {
    // 1. Busca os rótulos amigáveis de pausas da organização
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

    const traducoesPadrao = {
      "Break": "Pausa Básica", "Meal": "Pausa Refeição", "Meeting": "Reunião", "Training": "Treinamento", "Away": "Ausente do PC", "Busy": "Ocupado"
    };

    let excedidos = [];
    let paginaAtual = 1;
    let temMaisDados = true;

    // 2. Coleta os membros em tempo real de forma paginada
    while (temMaisDados) {
      const response = await fetch(`${cleanUrl}/api/v2/routing/queues/${queueId}/members?expand=presence&pageSize=100&pageNumber=${paginaAtual}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      });

      const rUsers = await response.json();
      if (!response.ok || !rUsers.entities || rUsers.entities.length === 0) break;

      rUsers.entities.forEach(member => {
        let uObj = member.user || member;
        let presenceObj = member.presence || uObj.presence || {};
        let presenceDef = presenceObj.presenceDefinition || {};
        let sysPresence = presenceDef.systemPresence || "Offline";
        let modifiedDate = presenceObj.modifiedDate || member.modifiedDate;

        // Regra WFM: Só audita se o agente NÃO estiver Offline e NÃO estiver Disponível ("On Queue" ou "Available")
        if (sysPresence !== "Offline" && sysPresence !== "On Queue" && sysPresence !== "Available") {
          if (modifiedDate) {
            let tempoTotalMs = Date.now() - new Date(modifiedDate).getTime();
            
            // Verifica se o tempo decorrido estourou a tolerância WFM informada
            if (tempoTotalMs > limiteToleranciaMs) {
              let statusSecundario = dicPresencas[presenceDef.id] || presenceDef.name || "";
              let statusAmigavel = traducoesPadrao[statusSecundario] || statusSecundario || traducoesPadrao[sysPresence] || sysPresence;
              let nomeAgente = member.name || uObj.name || "Operador Desconhecido";

              excedidos.push({
                id: uObj.id || member.id,
                nome: nomeAgente,
                status: statusAmigavel,
                tempoTotalMs: tempoTotalMs,
                toleranciaConfigurada: parseInt(toleranciaMinutos) || 15,
                tempoEstouroMs: tempoTotalMs - limiteToleranciaMs
              });
            }
          }
        }
      });

      if (!rUsers.nextUri) temMaisDados = false; else paginaAtual++;
    }

    // Ordena do maior estouro de tempo para o menor
    excedidos.sort((a, b) => b.tempoEstouroMs - a.tempoEstouroMs);

    return res.status(200).json({ ok: true, excedidos });

  } catch (e) {
    return res.status(200).json({ erro: 'Falha interna ao auditar pausas WFM: ' + e.message });
  }
}
