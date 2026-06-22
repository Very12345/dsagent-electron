from pathlib import Path
path = Path('agentview.html')
text = path.read_text(encoding='utf-8')
start = text.find('<div id="chat-container">')
print('chat-container start', start)
area_start = text.find('<div id="chat-area">', start)
print('chat-area start', area_start)
button_start = text.find('<button id="scroll-to-bottom-btn"', area_start)
print('button start', button_start)
button_end = text.find('</button>', button_start)
print('button end', button_end)
if button_end != -1:
    button_end += len('</button>')
bottom_panel_start = text.find('<div id="bottom-panel">', button_end)
print('bottom-panel start', bottom_panel_start)
if bottom_panel_start == -1:
    raise SystemExit('bottom-panel not found')
# Move bottom panel before chat area
old_chunk = text[area_start:bottom_panel_start]
new_chunk = text[bottom_panel_start:bottom_panel_start] + text[area_start:button_end]  # ???
print('old chunk length', len(old_chunk))
print('done')
