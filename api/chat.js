// /api/chat.js - Webhook version that sends data to Google Apps Script

module.exports = async function handler(req, res) {
  console.log('=== API FUNCTION START ===');
  
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  try {
    // --- ENV CHECK ---
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || 'asst_z7gDB3oQGSKyaqnSmGL82onH';
    const GOOGLE_WEBHOOK_URL = process.env.GOOGLE_WEBHOOK_URL || 'https://script.google.com/macros/s/AKfycbxGuPqieLmigdv47vktBJW_3RawTb6bAQhsbeaLODhU2AuWQI4OtTs4-Pgwe76-GIsE8w/exec';

    console.log('OpenAI API Key:', OPENAI_API_KEY ? 'Present' : 'Missing');
    console.log('Google Webhook URL:', GOOGLE_WEBHOOK_URL ? 'Present' : 'Missing');
    console.log('Google Webhook URL Value:', GOOGLE_WEBHOOK_URL);
    console.log('All Environment Variables:', Object.keys(process.env));

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ 
        success: false, 
        error: 'OpenAI API key not configured' 
      });
    }

    // --- REQUEST DATA ---
    const { message, userId, threadId } = req.body;
    
    if (!message) {
      return res.status(400).json({ 
        success: false, 
        error: "Message is required" 
      });
    }

    let currentThreadId = threadId;

    // 1. Create thread if needed
    if (!currentThreadId) {
      console.log('Creating new OpenAI thread...');
      const threadResp = await fetch('https://api.openai.com/v1/threads', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      });
      
      if (!threadResp.ok) {
        throw new Error(`Failed to create thread: ${threadResp.status}`);
      }
      
      const threadJson = await threadResp.json();
      currentThreadId = threadJson.id;
      console.log('Thread created:', currentThreadId);
    }

    // 2. Add user message
    await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        role: 'user',
        content: message
      })
    });

    // 3. Function definitions for webhook
    const functionTools = [
      {
        type: "function",
        function: {
          name: "save_company_info",
          description: "Save basic company information",
          parameters: {
            type: "object",
            properties: {
              company_name: { type: "string" },
              industry: { type: "string" },
              employee_count: { type: "string" },
              annual_revenue: { type: "string" }
            },
            required: ["company_name", "industry"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "save_contact_info",
          description: "Save contact information for quote generation",
          parameters: {
            type: "object",
            properties: {
              contact_name: { type: "string" },
              mobile_number: { type: "string" },
              email_address: { type: "string" }
            },
            required: ["contact_name", "mobile_number"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "save_category_score",
          description: "Save a calculated score for a security category",
          parameters: {
            type: "object",
            properties: {
              category: { 
                type: "string",
                enum: [
                  "MFA Score", "Backup Score", "Vulnerability Score", 
                  "Incident Response Score", "Training Score", "Network Security Score",
                  "Data Protection Score", "Endpoint Protection Score", 
                  "Security Monitoring Score", "Physical Security Score",
                  "Vendor Risk Score", "Business Continuity Score", 
                  "Compliance Score", "Identity Management Score",
                  "Payment Security Score", "Healthcare Data Score", 
                  "Security Testing Score", "Insurance History Score"
                ]
              },
              score: { 
                type: "number",
                minimum: 1,
                maximum: 4
              }
            },
            required: ["category", "score"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "generate_quote",
          description: "Generate insurance quote",
          parameters: {
            type: "object",
            properties: {},
            required: []
          }
        }
      }
    ];

    // 4. Start run
    const runResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        assistant_id: ASSISTANT_ID,
        tools: functionTools
      })
    });
    
    const runJson = await runResp.json();
    let runId = runJson.id;

    // 5. Wait for completion
    let attempts = 0;
    const maxAttempts = 20;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      attempts++;
      
      const statusResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs/${runId}`, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2'
        }
      });
      
      const runStatus = await statusResp.json();
      console.log(`Run status: ${runStatus.status}`);
      
      if (runStatus.status === 'completed') {
        // Get assistant response
        const messagesResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/messages`, {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        });
        
        const messagesJson = await messagesResp.json();
        const assistantMessage = messagesJson.data.find(msg => msg.role === 'assistant');
        
        if (assistantMessage && assistantMessage.content[0]?.text?.value) {
          return res.status(200).json({
            success: true,
            response: assistantMessage.content[0].text.value,
            threadId: currentThreadId
          });
        }
      }
      
      if (runStatus.status === 'requires_action') {
        console.log('Handling function calls...');
        const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
        const toolOutputs = [];
        
        for (const toolCall of toolCalls) {
          const functionName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);
          
          console.log(`Executing function: ${functionName}`, args);
          
          let result;
          if (functionName === 'save_company_info') {
            result = await sendToWebhook('company_info', {
              ...args,
              thread_id: currentThreadId,
              user_id: userId || 'user_' + Date.now(),
              timestamp: new Date().toISOString()
            }, GOOGLE_WEBHOOK_URL);
            
          } else if (functionName === 'save_contact_info') {
            result = await sendToWebhook('contact_info', {
              ...args,
              thread_id: currentThreadId,
              timestamp: new Date().toISOString()
            }, GOOGLE_WEBHOOK_URL);
            
          } else if (functionName === 'save_category_score') {
            result = await sendToWebhook('category_score', {
              ...args,
              thread_id: currentThreadId,
              timestamp: new Date().toISOString()
            }, GOOGLE_WEBHOOK_URL);
            
          } else if (functionName === 'generate_quote') {
            result = await sendToWebhook('generate_quote', {
              thread_id: currentThreadId,
              timestamp: new Date().toISOString()
            }, GOOGLE_WEBHOOK_URL);
            
          } else {
            result = { status: 'success', message: 'Function called' };
          }
          
          toolOutputs.push({
            tool_call_id: toolCall.id,
            output: JSON.stringify(result)
          });
        }
        
        // Submit tool outputs
        await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs/${runId}/submit_tool_outputs`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
          },
          body: JSON.stringify({
            tool_outputs: toolOutputs
          })
        });
      }
      
      if (runStatus.status === 'failed' || runStatus.status === 'cancelled' || runStatus.status === 'expired') {
        throw new Error(`Run ${runStatus.status}`);
      }
    }
    
    return res.status(500).json({
      success: false,
      error: 'Run timeout'
    });
    
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

// --- Webhook Helper Function ---
async function sendToWebhook(action, data, webhookUrl) {
  try {
    if (!webhookUrl) {
      console.log('No webhook URL configured, returning mock success');
      return { 
        status: 'success', 
        message: `${action} saved (webhook not configured)` 
      };
    }

    console.log(`Sending webhook: ${action}`, data);
    
    const webhookData = {
      action: action,
      data: data,
      timestamp: new Date().toISOString()
    };
    
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(webhookData)
    });
    
    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status}`);
    }
    
    const result = await response.json();
    console.log('Webhook response:', result);
    
    return { 
      status: 'success', 
      message: `${action} saved successfully`,
      webhook_response: result
    };
    
  } catch (error) {
    console.error('Webhook error:', error);
    return {
      status: 'error',
      message: `Webhook failed: ${error.message}`
    };
  }
}
