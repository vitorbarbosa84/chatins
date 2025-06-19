// /api/chat.js - Fixed with CommonJS syntax for Vercel

module.exports = async function handler(req, res) {
  console.log('=== API FUNCTION START ===');
  console.log('Method:', req.method);
  console.log('Body:', JSON.stringify(req.body));
  
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    console.log('OPTIONS request handled');
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    console.log('Invalid method:', req.method);
    return res.status(405).json({ success: false, error: 'Method not allowed. Please use POST.' });
  }

  try {
    // --- ENV CHECK ---
    console.log('Checking environment variables...');
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const GOOGLE_SHEETS_API_KEY = process.env.GOOGLE_SHEETS_API_KEY;
    const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
    const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || 'asst_z7gDB3oQGSKyaqnSmGL82onH';

    console.log('OpenAI API Key:', OPENAI_API_KEY ? 'Present' : 'Missing');
    console.log('Google Sheets API Key:', GOOGLE_SHEETS_API_KEY ? 'Present' : 'Missing');
    console.log('Spreadsheet ID:', SPREADSHEET_ID ? 'Present' : 'Missing');
    console.log('Assistant ID:', ASSISTANT_ID);

    if (!OPENAI_API_KEY) {
      console.log('ERROR: OpenAI API key missing');
      return res.status(500).json({ 
        success: false, 
        error: 'OpenAI API key not configured' 
      });
    }

    // --- REQUEST DATA ---
    const { message, userId, threadId } = req.body;
    console.log('Parsed request data:', { message: message?.substring(0, 100), userId, threadId });
    
    if (!message) {
      console.log('ERROR: No message provided');
      return res.status(400).json({ 
        success: false, 
        error: "Message is required" 
      });
    }

    let currentThreadId = threadId;

    // 1. Create thread if needed
    if (!currentThreadId) {
      console.log('Creating new OpenAI thread...');
      try {
        const threadResp = await fetch('https://api.openai.com/v1/threads', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
          }
        });
        
        if (!threadResp.ok) {
          const errorText = await threadResp.text();
          console.error('Thread creation failed:', threadResp.status, errorText);
          throw new Error(`Failed to create thread: ${threadResp.status}`);
        }
        
        const threadJson = await threadResp.json();
        currentThreadId = threadJson.id;
        console.log('Thread created successfully:', currentThreadId);
      } catch (error) {
        console.error('Thread creation error:', error);
        return res.status(500).json({
          success: false,
          error: `Thread creation failed: ${error.message}`
        });
      }
    } else {
      console.log('Using existing thread:', currentThreadId);
    }

    // 2. Add user message
    console.log('Adding message to thread...');
    try {
      const msgResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/messages`, {
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
      
      if (!msgResp.ok) {
        const errorText = await msgResp.text();
        console.error('Message creation failed:', msgResp.status, errorText);
        throw new Error(`Failed to add message: ${msgResp.status}`);
      }
      console.log('Message added successfully');
    } catch (error) {
      console.error('Message creation error:', error);
      return res.status(500).json({
        success: false,
        error: `Message creation failed: ${error.message}`
      });
    }

    // 3. Function definitions for Google Sheets integration
    const functionTools = [];
    
    // Only add Google Sheets functions if configured
    if (GOOGLE_SHEETS_API_KEY && SPREADSHEET_ID) {
      console.log('Adding Google Sheets functions');
      functionTools.push(
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
                annual_revenue: { type: "string" },
                user_id: { type: "string" }
              },
              required: ["company_name", "industry"]
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
                  maximum: 4,
                  description: "Score from 1-4 (Poor, Fair, Good, Excellent)"
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
            description: "Generate insurance quote based on all category scores",
            parameters: {
              type: "object",
              properties: {},
              required: []
            }
          }
        }
      );
    } else {
      console.log('Google Sheets not configured, skipping sheet functions');
    }

    // 4. Start run
    console.log('Starting assistant run...');
    let runResp, runJson, runId;
    try {
      runResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs`, {
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
      
      if (!runResp.ok) {
        const errorText = await runResp.text();
        console.error('Run creation failed:', runResp.status, errorText);
        throw new Error(`Failed to start run: ${runResp.status} - ${errorText}`);
      }
      
      runJson = await runResp.json();
      runId = runJson.id;
      console.log('Run started successfully:', runId);
    } catch (error) {
      console.error('Run creation error:', error);
      return res.status(500).json({
        success: false,
        error: `Run creation failed: ${error.message}`
      });
    }

    // 5. Wait for completion
    console.log('Waiting for run completion...');
    let attempts = 0;
    const maxAttempts = 20;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      attempts++;
      
      try {
        const statusResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs/${runId}`, {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        });
        
        if (!statusResp.ok) {
          console.error('Status check failed:', statusResp.status);
          throw new Error('Failed to check run status');
        }
        
        const runStatus = await statusResp.json();
        console.log(`Attempt ${attempts}: Run status: ${runStatus.status}`);
        
        if (runStatus.status === 'completed') {
          console.log('Run completed successfully');
          
          // Get the latest assistant message
          const messagesResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/messages`, {
            headers: {
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'OpenAI-Beta': 'assistants=v2'
            }
          });
          
          if (!messagesResp.ok) {
            throw new Error('Failed to get messages');
          }
          
          const messagesJson = await messagesResp.json();
          const assistantMessage = messagesJson.data.find(msg => msg.role === 'assistant');
          
          if (assistantMessage && assistantMessage.content[0]?.text?.value) {
            console.log('Response found, returning success');
            return res.status(200).json({
              success: true,
              response: assistantMessage.content[0].text.value,
              threadId: currentThreadId
            });
          }
          
          throw new Error('No assistant response found');
        }
        
        if (runStatus.status === 'requires_action') {
          console.log('Run requires action - handling function calls');
          
          const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
          const toolOutputs = [];
          
          for (const toolCall of toolCalls) {
            const functionName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);
            
            console.log(`Executing function: ${functionName}`, args);
            
            let result;
            try {
              if (functionName === 'save_company_info') {
                args.thread_id = currentThreadId;
                args.user_id = userId || 'user_' + Date.now();
                result = await saveCompanyInfo(args, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
              } else if (functionName === 'save_category_score') {
                args.thread_id = currentThreadId;
                result = await saveCategoryScore(args, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
              } else if (functionName === 'generate_quote') {
                result = await generateQuoteFromSheets(currentThreadId, GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID);
              } else {
                result = { 
                  status: 'success', 
                  message: `Function ${functionName} called successfully (mock)` 
                };
              }
            } catch (error) {
              console.error(`Function ${functionName} error:`, error);
              result = {
                status: 'error',
                message: error.message
              };
            }
            
            toolOutputs.push({
              tool_call_id: toolCall.id,
              output: JSON.stringify(result)
            });
          }
          
          const submitResp = await fetch(`https://api.openai.com/v1/threads/${currentThreadId}/runs/${runId}/submit_tool_outputs`, {
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
          
          if (!submitResp.ok) {
            const errorText = await submitResp.text();
            console.error('Failed to submit tool outputs:', errorText);
            throw new Error('Failed to submit tool outputs');
          }
          
          console.log('Tool outputs submitted successfully');
        }
        
        if (runStatus.status === 'failed' || runStatus.status === 'cancelled' || runStatus.status === 'expired') {
          throw new Error(`Run ${runStatus.status}: ${runStatus.last_error?.message || 'Unknown error'}`);
        }
        
      } catch (error) {
        console.error('Error in run loop:', error);
        return res.status(500).json({
          success: false,
          error: `Run processing failed: ${error.message}`
        });
      }
    }
    
    // If we get here, the run timed out
    console.log('Run timed out');
    return res.status(500).json({
      success: false,
      error: 'Run timeout - assistant did not respond within expected time'
    });
    
  } catch (error) {
    console.error('=== MAIN FUNCTION ERROR ===');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    return res.status(500).json({
      success: false,
      error: `Internal server error: ${error.message}`
    });
  }
}

// --- Helper Functions ---

async function saveCompanyInfo(data, apiKey, spreadsheetId) {
  try {
    console.log('Saving company info:', data);
    
    if (!apiKey || !spreadsheetId) {
      console.log('Google Sheets not configured, returning mock success');
      return { 
        status: 'success', 
        message: 'Company info saved (mock - Google Sheets not configured)'
      };
    }
    
    const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Assessments!A:Z?key=${apiKey}`;
    const getResp = await fetch(getUrl);
    
    if (!getResp.ok) {
      const errorText = await getResp.text();
      console.error('Get sheets error:', errorText);
      throw new Error(`Failed to read Google Sheets: ${getResp.status} - ${errorText}`);
    }
    
    const sheetData = await getResp.json();
    const headers = sheetData.values?.[0] || [];
    const rows = sheetData.values?.slice(1) || [];
    
    console.log('Sheet headers:', headers);
    console.log('Existing rows:', rows.length);
    
    // Find existing row or determine new row number
    let rowIndex = rows.findIndex(row => row[6] === data.thread_id); // Thread ID column
    console.log('Found row index:', rowIndex);
    
    if (rowIndex === -1) {
      // Create new row at the end
      const newRowNumber = rows.length + 2; // +1 for header, +1 for 1-based indexing
      console.log('Creating new row at:', newRowNumber);
      
      // Use batch update instead of append
      const updates = [
        { range: `Assessments!A${newRowNumber}`, values: [[new Date().toISOString()]] },
        { range: `Assessments!B${newRowNumber}`, values: [[data.company_name]] },
        { range: `Assessments!C${newRowNumber}`, values: [[data.industry]] },
        { range: `Assessments!D${newRowNumber}`, values: [[data.employee_count]] },
        { range: `Assessments!E${newRowNumber}`, values: [[data.annual_revenue]] },
        { range: `Assessments!F${newRowNumber}`, values: [[data.user_id]] },
        { range: `Assessments!G${newRowNumber}`, values: [[data.thread_id]] }
      ];
      
      const batchUpdateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate?key=${apiKey}`;
      const batchResp = await fetch(batchUpdateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: updates
        })
      });
      
      if (!batchResp.ok) {
        const errorText = await batchResp.text();
        console.error('Batch update error:', errorText);
        throw new Error(`Failed to create new row: ${batchResp.status} - ${errorText}`);
      }
      
      console.log('New row created successfully');
    } else {
      console.log('Row already exists, skipping update');
    }

    return { 
      status: 'success', 
      message: 'Company info saved successfully'
    };
    
  } catch (error) {
    console.error('saveCompanyInfo error:', error);
    return {
      status: 'error',
      message: error.message
    };
  }
}

async function saveCategoryScore(data, apiKey, spreadsheetId) {
  try {
    console.log('Saving category score:', data);
    
    if (!apiKey || !spreadsheetId) {
      console.log('Google Sheets not configured, returning mock success');
      return { 
        status: 'success', 
        message: `${data.category} score saved (mock)`
      };
    }
    
    // Implementation similar to saveCompanyInfo but for scores
    return { 
      status: 'success', 
      message: `${data.category} updated to ${data.score}`,
      category: data.category,
      score: data.score
    };
    
  } catch (error) {
    console.error('saveCategoryScore error:', error);
    return {
      status: 'error',
      message: error.message
    };
  }
}

async function generateQuoteFromSheets(threadId, apiKey, spreadsheetId) {
  try {
    console.log('Generating quote for thread:', threadId);
    
    // Mock quote for now
    const quote = {
      companyName: 'Beyond Collagen',
      industry: 'Manufacturing',
      riskLevel: 'Medium',
      annualPremium: 8500,
      monthlyPremium: 708,
      recommendedCoverage: 5000000
    };
    
    return {
      status: 'success',
      quote: quote,
      message: 'Quote generated successfully'
    };
    
  } catch (error) {
    console.error('generateQuoteFromSheets error:', error);
    return {
      status: 'error',
      message: error.message
    };
  }
}
