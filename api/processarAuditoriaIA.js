export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  const { token, baseUrl, conversationId, provider, model, apiKey, customPrompt } = req.body; [cite: 154]

  if (!token) return res.status(200).json({ erro: 'Token Genesys Cloud ausente.' }); [cite: 154, 155]
  if (!conversationId) return res.status(200).json({ erro: 'ID da interação ausente.' }); [cite: 155]
  if (!apiKey) return res.status(200).json({ erro: 'Chave de API ausente.' }); [cite: 156]

  let cleanUrl = (baseUrl || 'https://api.sae1.pure.cloud').trim().replace(/\/$/, ''); [cite: 156]
  const headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" }; [cite: 157]

  // Helpers auxiliares locais
  function extrairNomeClienteSeguro(participante) {
    let nomeEncontrado = participante.name || ""; [cite: 145]
    if (participante.attributes) { [cite: 146]
      Object.keys(participante.attributes).forEach(function(key) {
        let lowerKey = key.toLowerCase();
        if (lowerKey.indexOf('nome') !== -1 || lowerKey.indexOf('name') !== -1 || lowerKey === 'contatonome') { [cite: 146]
          let val = String(participante.attributes[key]).trim(); [cite: 146]
          if (val && val.length > 2 && !/^[\d\+\s]+$/.test(val)) { [cite: 146]
            nomeEncontrado = val; [cite: 146]
          }
        }
      });
    }
    if (!nomeEncontrado) return "Não Identificado"; [cite: 147]
    let limpo = String(nomeEncontrado).split('|')[0].split('/')[0].split('-')[0].trim(); [cite: 147]
    if (/^[\d\+\s\:]+$/.test(limpo) || limpo.toLowerCase() === 'guest' || limpo.toLowerCase() === 'cliente') { [cite: 148]
      return "Não Identificado"; [cite: 148]
    }
    return limpo; [cite: 149]
  }

  async function obterNomeFinalizacao(wrapupId) {
    if (!wrapupId) return "Sem Finalização";
    if (String(wrapupId).startsWith("ININ-")) return wrapupId.replace("ININ-WRAP-UP-", "").replace("ININ-OUTBOUND-", ""); [cite: 113, 114]
    const response = await fetch(`${cleanUrl}/api/v2/routing/wrapupcodes/${wrapupId}`, { headers });
    const r = await response.json();
    return r && r.name ? r.name : `Código (${wrapupId})`; [cite: 115, 116]
  }

  try {
    // 1. Busca detalhes da Interação no Genesys
    const reqConv = await fetch(`${cleanUrl}/api/v2/conversations/${conversationId}`, { headers }); [cite: 158]
    const resConv = await reqConv.json(); [cite: 159]
    if (!reqConv.ok || resConv.message || resConv.status === 404) return res.status(200).json({ erro: 'Interação não encontrada.' }); [cite: 160]

    let cliente = "Desconhecido"; [cite: 161]
    let sessions = []; [cite: 161]
    let nomesAgentes = []; [cite: 161]
    let tabulacoesLista = []; [cite: 161]

    for (const p of (resConv.participants || [])) { [cite: 161, 162]
      if (p.purpose === 'customer' || p.purpose === 'external') { [cite: 162]
         cliente = extrairNomeClienteSeguro(p); [cite: 162]
      }
      
      if (p.purpose === 'agent' || p.purpose === 'user') { [cite: 162]
        let agName = p.name || "Operador Desconhecido"; [cite: 162]
        if (!nomesAgentes.includes(agName)) nomesAgentes.push(agName); [cite: 162]

        let wName = "Sem Tabulação"; [cite: 162]
        if (p.wrapup && p.wrapup.code) { [cite: 162]
           wName = p.wrapup.name || await obterNomeFinalizacao(p.wrapup.code); [cite: 162]
        } else {
           let foundWrapup = false; [cite: 163]
           for (const media of ['sessions', 'calls', 'chats', 'messages', 'emails']) { [cite: 163]
               if (p[media] && Array.isArray(p[media])) { [cite: 163]
                   for (const s of p[media]) { [cite: 163]
                       for (const sg of (s.segments || [])) { [cite: 163]
                           if (sg.wrapUpCode && !foundWrapup) { [cite: 164]
                               wName = await obterNomeFinalizacao(sg.wrapUpCode); [cite: 164]
                               foundWrapup = true; [cite: 164]
                           }
                       }
                   }
               }
           }
        }
        tabulacoesLista.push(`<b>${agName}:</b> ${wName}`); [cite: 166]
      }

      if (p.messages && Array.isArray(p.messages)) sessions = sessions.concat(p.messages); [cite: 167]
      if (p.chats && Array.isArray(p.chats)) sessions = sessions.concat(p.chats); [cite: 167]
    }

    let agente = nomesAgentes.join(", ") || "Nenhum Humano"; [cite: 168]
    let wrapup = tabulacoesLista.join(" <br> ") || "Nenhuma Tabulação Registrada"; [cite: 168]
    let urlsProcessadas = []; [cite: 169]
    let frasesBrutas = []; [cite: 169]

    // 2. Coleta as URLs de Transcrição geradas pelo motor de Analytics
    for (const s of sessions) { [cite: 169]
      try {
        const tUrl = `${cleanUrl}/api/v2/speechandtextanalytics/conversations/${conversationId}/communications/${s.id}/transcripturls`; [cite: 169]
        const resT = await fetch(tUrl, { headers }); [cite: 169]
        if (resT.status === 200) { [cite: 169]
          const resJson = await resT.json(); [cite: 169]
          if (resJson.urls && Array.isArray(resJson.urls)) { [cite: 169]
            for (const u of resJson.urls) { [cite: 169]
              if (urlsProcessadas.indexOf(u.url) === -1) { [cite: 170]
                urlsProcessadas.push(u.url); [cite: 170]
                const resS3 = await fetch(u.url); [cite: 170]
                if (resS3.status === 200) { [cite: 170]
                  const transcritosObj = await resS3.json(); [cite: 170]
                  if (transcritosObj.transcripts && Array.isArray(transcritosObj.transcripts)) { [cite: 170]
                    transcritosObj.transcripts.forEach(t => { [cite: 171]
                      if (t.phrases && Array.isArray(t.phrases)) { [cite: 171]
                        t.phrases.forEach(phrase => frasesBrutas.push(phrase)); [cite: 171]
                      }
                    });
                  }
                }
              }
            }
          }
        }
      } catch (e) { console.error("Falha silenciosa na S3", e); } [cite: 174]
    }

    if (frasesBrutas.length === 0) { [cite: 175]
       return res.status(200).json({ erro: 'Nenhuma transcrição encontrada pelo motor de Analytics para esta conversa.' }); [cite: 175]
    }

    // Ordena as falas cronologicamente [cite: 176]
    frasesBrutas.sort(function(a, b) { [cite: 176]
      let timeA = a.startTimeMs ? Number(a.startTimeMs) : (a.startTime ? new Date(a.startTime).getTime() : 0); [cite: 176]
      let timeB = b.startTimeMs ? Number(b.startTimeMs) : (b.startTime ? new Date(b.startTime).getTime() : 0); [cite: 176]
      return timeA - timeB; [cite: 176]
    });

    let transcricao = ""; [cite: 177]
    frasesBrutas.forEach(function(phrase) { [cite: 177]
      let purpose = String(phrase.participantPurpose || "").toLowerCase(); [cite: 177]
      let speaker = "CLIENTE"; [cite: 177]
      if (purpose === "agent" || purpose === "user") speaker = "OPERADOR HUMANO"; [cite: 177]
      else if (["botflow", "workflow", "acd", "ivr", "system"].includes(purpose)) speaker = "SISTEMA/URA"; [cite: 177]
      transcricao += `${speaker}: ${phrase.text}\n`; [cite: 177]
    });
    
    let instrucoesDinamicas = (customPrompt && customPrompt.trim() !== "") ? customPrompt.trim() : [cite: 178]
      `1. Resumo do Caso: O que o cliente solicitou e qual foi o motivo real do cancelamento/insatisfação alegado?
2. Tratativa de Retenção: O(s) Operador(es) Humano(s) aplicou(ram) técnicas para reter o cliente? Foque a avaliação apenas na postura dos operadores humanos.
3. Tabulação: As tabulações aplicadas refletem corretamente o desfecho da conversa?
4. Feedback da IA: Apresente sua visão analítica. É um atendimento aprovado, passível de feedback ou crítico?`; [cite: 179, 180, 181, 182, 183, 184]

    const prompt = `Você é um auditor sênior de qualidade e retenção da empresa de telecomunicações Brisanet. 
DADOS DA INTERAÇÃO NO SISTEMA:
- Nome capturado: ${cliente} | Operadores: ${agente} | Tabulações: ${wrapup.replace(/<b>|<\/b>/g, '')} [cite: 185, 186]
TRANSCRIÇÃO DO ATENDIMENTO:
${transcricao}
INSTRUÇÕES DE ANÁLISE:
${instrucoesDinamicas} [cite: 186]

REGRAS DE FORMATAÇÃO — SIGA EXATAMENTE ESTA ESTRUTURA:
Sua resposta DEVE começar com exatamente estas duas linhas (sem texto antes, sem asteriscos, sem numeração):

CLIENTE: [nome real do cliente extraído da transcrição, ou a palavra: Não identificado]
DESFECHO: [escreva APENAS UMA das três opções a seguir, sem parênteses nem explicação adicional: Retido | Cancelado | Outro] [cite: 186, 187]

Em seguida, coloque exatamente três sinais de igual em uma linha separada:
===
[Depois do === escreva o relatório de auditoria em HTML simples usando: <h4>, <ul>, <li>, <p> e <strong>. Nunca use blocos de código] [cite: 187, 188]`;

    let iaResult = ""; [cite: 188]

    // 3. Comunicação externa com o Provedor de IA escolhido [cite: 189]
    if (provider === 'gemini') { [cite: 189]
       const gPayload = { contents: [{ parts: [{ text: prompt }] }] }; [cite: 189]
       const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`; [cite: 190]
       const gRes = await fetch(gUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gPayload) }); [cite: 191]
       const gJson = await gRes.json(); [cite: 192]
       if (gJson.error) return res.status(200).json({ erro: 'Erro na API Gemini: ' + gJson.error.message }); [cite: 192]
       iaResult = gJson.candidates[0].content.parts[0].text; [cite: 193]
    } else if (provider === 'groq') { [cite: 193]
       const qPayload = { model: model, messages: [{ role: "user", content: prompt }] }; [cite: 193]
       const qRes = await fetch('https://api.groq.com/openai/v1/chat/completions', { [cite: 194]
         method: 'POST', 
         headers: { 'Authorization': 'Bearer ' + apiKey.trim(), 'Content-Type': 'application/json' }, [cite: 194]
         body: JSON.stringify(qPayload)
       });
       const qJson = await qRes.json(); [cite: 195]
       if (qJson.error) return res.status(200).json({ erro: 'Erro na API Groq: ' + qJson.error.message }); [cite: 195]
       iaResult = qJson.choices[0].message.content; [cite: 196]
    } else {
       return res.status(200).json({ erro: 'Provedor de IA desconhecido.' }); [cite: 196, 197]
    }
  
    // 4. Parser Inteligente do Cabeçalho e HTML [cite: 198]
    iaResult = iaResult.replace(/
http://googleusercontent.com/immersive_entry_chip/0
4. Clique em **Commit changes...** para salvar.

---

### Tudo Pronto! Sua Migração Foi Concluída 🚀

Sua aplicação agora está completamente independente do ecossistema do Google Apps Script! Você dividiu o seu projeto de forma profissional:
* **Frontend:** Servido estaticamente direto na raiz pelo arquivo `index.html`.
* **Backend:** Sete endpoints de microsserviços (funções Serverless de Node.js rápido) dentro da sua pasta `/api`.

Toda vez que você quiser alterar uma regra de negócio ou mudar uma tradução, basta editar os arquivos direto pelo repositório online do GitHub. Em questão de segundos, a Vercel atualiza sua aplicação automaticamente em produção.

Faça um teste agora nas abas de Inteligência Artificial com sua chave do Groq ou Gemini! Tudo funcionando como esperado?
