export default async function handler(req, res) {
  // Habilita CORS para evitar qualquer bloqueio entre chamadas em lote
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { token, baseUrl, conversationId, provider, model, apiKey, customPrompt } = req.body;

  if (!token) return res.status(200).json({ erro: 'Token Genesys Cloud ausente.' });
  if (!conversationId) return res.status(200).json({ erro: 'ID da interação ausente.' });
  if (!apiKey) return res.status(200).json({ erro: 'Chave de API ausente.' });

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, '');
  const headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };

  // Helpers auxiliares locais protegidos
  function extrairNomeClienteSeguro(participante) {
    let nomeEncontrado = participante.name || "";
    if (participante.attributes) {
      Object.keys(participante.attributes).forEach(function(key) {
        let lowerKey = key.toLowerCase();
        if (lowerKey.indexOf('nome') !== -1 || lowerKey.indexOf('name') !== -1 || lowerKey === 'contatonome') {
          let val = String(participante.attributes[key]).trim();
          if (val && val.length > 2 && !/^[\d\+\s]+$/.test(val)) {
            nomeEncontrado = val;
          }
        }
      });
    }
    if (!nomeEncontrado) return "Não Identificado";
    let limpo = String(nomeEncontrado).split('|')[0].split('/')[0].split('-')[0].trim();
    if (/^[\d\+\s\:]+$/.test(limpo) || limpo.toLowerCase() === 'guest' || limpo.toLowerCase() === 'cliente') {
      return "Não Identificado";
    }
    return limpo;
  }

  async function obterNomeFinalizacao(wrapupId) {
    if (!wrapupId) return "Sem Finalização";
    if (String(wrapupId).startsWith("ININ-")) return wrapupId.replace("ININ-WRAP-UP-", "").replace("ININ-OUTBOUND-", "");
    try {
      const response = await fetch(`${cleanUrl}/api/v2/routing/wrapupcodes/${wrapupId}`, { headers });
      if (!response.ok) return `Código (${wrapupId})`;
      const r = await response.json();
      return r && r.name ? r.name : `Código (${wrapupId})`;
    } catch (e) {
      return `Código (${wrapupId})`;
    }
  }

  try {
    // 1. Busca detalhes da Interação no Genesys
    const reqConv = await fetch(`${cleanUrl}/api/v2/conversations/${conversationId}`, { headers });
    const resConv = await reqConv.json();
    if (!reqConv.ok || resConv.message || resConv.status === 404) return res.status(200).json({ erro: 'Interação não encontrada.' });

    let cliente = "Desconhecido";
    let sessions = [];
    let nomesAgentes = [];
    let tabulacoesLista = [];

    for (const p of (resConv.participants || [])) {
      if (p.purpose === 'customer' || p.purpose === 'external') {
         cliente = extrairNomeClienteSeguro(p);
      }
      
      if (p.purpose === 'agent' || p.purpose === 'user') {
        let agName = p.name || "Operador Desconhecido";
        if (!nomesAgentes.includes(agName)) nomesAgentes.push(agName);

        let wName = "Sem Tabulação";
        if (p.wrapup && p.wrapup.code) {
           wName = p.wrapup.name || await obterNomeFinalizacao(p.wrapup.code);
        } else {
           let foundWrapup = false;
           for (const media of ['sessions', 'calls', 'chats', 'messages', 'emails']) {
               if (p[media] && Array.isArray(p[media])) {
                   for (const s of p[media]) {
                       for (const sg of (s.segments || [])) {
                           if (sg.wrapUpCode && !foundWrapup) {
                               wName = await obterNomeFinalizacao(sg.wrapUpCode);
                               foundWrapup = true;
                           }
                       }
                   }
               }
           }
        }
        tabulacoesLista.push(`<b>${agName}:</b> ${wName}`);
      }

      if (p.messages && Array.isArray(p.messages)) sessions = sessions.concat(p.messages);
      if (p.chats && Array.isArray(p.chats)) sessions = sessions.concat(p.chats);
    }

    let agente = nomesAgentes.join(", ") || "Nenhum Humano";
    let wrapup = tabulacoesLista.join(" <br> ") || "Nenhuma Tabulação Registrada";
    let urlsProcessadas = [];
    let frasesBrutas = [];

    // 2. Coleta as URLs de Transcrição geradas pelo motor de Analytics
    for (const s of sessions) {
      try {
        const tUrl = `${cleanUrl}/api/v2/speechandtextanalytics/conversations/${conversationId}/communications/${s.id}/transcripturls`;
        const resT = await fetch(tUrl, { headers });
        if (resT.status === 200) {
          const resJson = await resT.json();
          if (resJson.urls && Array.isArray(resJson.urls)) {
            for (const u of resJson.urls) {
              if (urlsProcessadas.indexOf(u.url) === -1) {
                urlsProcessadas.push(u.url);
                const resS3 = await fetch(u.url);
                if (resS3.status === 200) {
                  const transcritosObj = await resS3.json();
                  if (transcritosObj.transcripts && Array.isArray(transcritosObj.transcripts)) {
                    transcritosObj.transcripts.forEach(t => {
                      if (t.phrases && Array.isArray(t.phrases)) {
                        t.phrases.forEach(phrase => frasesBrutas.push(phrase));
                      }
                    });
                  }
                }
              }
            }
          }
        }
      } catch (e) { console.error("Falha silenciosa na S3", e); }
    }

    if (frasesBrutas.length === 0) {
       return res.status(200).json({ erro: 'Nenhuma transcrição encontrada pelo motor de Analytics para esta conversa.' });
    }

    // Ordena as falas cronologicamente
    frasesBrutas.sort(function(a, b) {
      let timeA = a.startTimeMs ? Number(a.startTimeMs) : (a.startTime ? new Date(a.startTime).getTime() : 0);
      let timeB = b.startTimeMs ? Number(b.startTimeMs) : (b.startTime ? new Date(b.startTime).getTime() : 0);
      return timeA - timeB;
    });

    let transcricao = "";
    frasesBrutas.forEach(function(phrase) {
      let purpose = String(phrase.participantPurpose || "").toLowerCase();
      let speaker = "CLIENTE";
      if (purpose === "agent" || purpose === "user") speaker = "OPERADOR HUMANO";
      else if (["botflow", "workflow", "acd", "ivr", "system"].includes(purpose)) speaker = "SISTEMA/URA";
      transcricao += `${speaker}: ${phrase.text}\n`;
    });
    
    let instrucoesDinamicas = (customPrompt && customPrompt.trim() !== "") ? customPrompt.trim() :
      `1. Resumo do Caso: O que o cliente solicitou e qual foi o motivo real do cancelamento/insatisfação alegado?
2. Tratativa de Retenção: O(s) Operador(es) Humano(s) aplicou(ram) técnicas para reter o cliente? Foque a avaliação apenas na postura dos operadores humanos.
3. Tabulação: As tabulações aplicadas refletem corretamente o desfecho da conversa?
4. Feedback da IA: Apresente sua visão analítica. É um atendimento aprovado, passível de feedback ou crítico?`;

    const prompt = `Você é um auditor sênior de qualidade e retenção da empresa de telecomunicações Brisanet.
DADOS DA INTERAÇÃO NO SISTEMA:
- Nome capturado: ${cliente} | Operadores: ${agente} | Tabulações: ${wrapup.replace(/<b>|<\/b>/g, '')}
TRANSCRIÇÃO DO ATENDIMENTO:
${transcricao}
INSTRUÇÕES DE ANÁLISE:
${instrucoesDinamicas}

REGRAS DE FORMATAÇÃO — SIGA EXATAMENTE ESTA ESTRUTURA:
Sua resposta DEVE começar com exatamente estas duas linhas (sem texto antes, sem asteriscos, sem numeração):

CLIENTE: [nome real do cliente extraído da transcrição, ou a palavra: Não identificado]
DESFECHO: [escreva APENAS UMA das três opções a seguir, sem parênteses nem explicação adicional: Retido | Cancelado | Outro]

Em seguida, coloque exatamente três sinais de igual em uma linha separada:
===
[Depois do === escreva o relatório de auditoria em HTML simples usando: <h4>, <ul>, <li>, <p> e <strong>. Nunca use blocos de código]`;

    let iaResult = "";

    // 3. Comunicação externa com o Provedor de IA escolhido
    if (provider === 'gemini') {
       const gPayload = { contents: [{ parts: [{ text: prompt }] }] };
       const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`;
       const gRes = await fetch(gUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gPayload) });
       const gJson = await gRes.json();
       if (gJson.error) return res.status(200).json({ erro: 'Erro na API Gemini: ' + gJson.error.message });
       iaResult = gJson.candidates[0].content.parts[0].text;
    } else if (provider === 'groq') {
       const qPayload = { model: model, messages: [{ role: "user", content: prompt }] };
       const qRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
         method: 'POST', 
         headers: { 'Authorization': 'Bearer ' + apiKey.trim(), 'Content-Type': 'application/json' },
         body: JSON.stringify(qPayload)
       });
       const qJson = await qRes.json();
       if (qJson.error) return res.status(200).json({ erro: 'Erro na API Groq: ' + qJson.error.message });
       iaResult = qJson.choices[0].message.content;
    } else {
       return res.status(200).json({ erro: 'Provedor de IA desconhecido.' });
    }
  
    // 4. Parser Inteligente e Protegido contra quebras (Elimina erro 500)
    iaResult = iaResult.replace(/```html/g, '').replace(/```/g, '').trim();
    iaResult = iaResult.replace(/\*\*(CLIENTE:|DESFECHO:)\*\*/gi, '$1').replace(/\*(CLIENTE:|DESFECHO:)\*/gi, '$1');
    
    let nomeClienteFinal = cliente;
    let htmlFinal = iaResult;
    let statusLote = "Outro";

    if (iaResult.includes('===')) {
      let idxSep = iaResult.indexOf('===');
      let cabecalho = iaResult.substring(0, idxSep).trim();
      htmlFinal = iaResult.substring(idxSep + 3).trim();
      
      cabecalho.split('\n').forEach(function(linha) {
        let lUpper = linha.trim().toUpperCase();
        if (lUpper.startsWith('CLIENTE:') && linha.includes(':')) {
          let extraido = linha.substring(linha.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '').replace(/\*+/g, '').trim();
          if (extraido && !['não identificado','desconhecido','cliente','n/a'].includes(extraido.toLowerCase())) nomeClienteFinal = extraido;
        }
        if (lUpper.startsWith('DESFECHO:') && linha.includes(':')) {
          let desfechoRaw = linha.substring(linha.indexOf(':') + 1).trim().replace(/\*+/g, '').replace(/[()\[\]]/g, '').trim().toUpperCase();
          if (desfechoRaw.includes('RETID')) statusLote = 'Retido';
          else if (desfechoRaw.includes('CANCEL')) statusLote = 'Cancelado';
        }
      });
    } else {
      let htmlLinhas = [];
      iaResult.split('\n').forEach(function(linha) {
        let lUpper = linha.trim().toUpperCase();
        if (lUpper.startsWith('CLIENTE:') && linha.includes(':')) {
          let extraido = linha.substring(linha.indexOf(':') + 1).trim().replace(/\*+/g, '').trim();
          if (extraido && !['não identificado','desconhecido','cliente','n/a'].includes(extraido.toLowerCase())) nomeClienteFinal = extraido;
        } else if (lUpper.startsWith('DESFECHO:') && linha.includes(':')) {
          let d = linha.substring(linha.indexOf(':') + 1).trim().replace(/\*+/g, '').toUpperCase();
          if (d.includes('RETID')) statusLote = 'Retido';
          else if (d.includes('CANCEL')) statusLote = 'Cancelado';
        } else {
          htmlLinhas.push(linha);
        }
      });
      htmlFinal = htmlLinhas.join('\n').trim();
    }

    // Fallback inteligente caso a IA mude a formatação da palavra chave
    let txtSemTags = htmlFinal.replace(/<[^>]+>/g, ' ').toLowerCase();
    if (statusLote === 'Outro') {
      if (txtSemTags.includes('retid') || txtSemTags.includes('retenção confirmada')) statusLote = 'Retido';
      else if (txtSemTags.includes('cancelad') || txtSemTags.includes('cancelamento efetivad')) statusLote = 'Cancelado';
    }

    return res.status(200).json({ ok: true, relatorioHTML: htmlFinal, cliente: nomeClienteFinal, agente: agente, wrapup: wrapup, desfechoLote: statusLote, id: conversationId });

  } catch (e) {
    // Qualquer erro agora é retornado como JSON seguro em vez de estourar erro 500 no servidor
    return res.status(200).json({ ok: false, erro: 'Erro interno no processamento: ' + e.message });
  }
}
