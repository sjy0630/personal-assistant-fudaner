"""Fixture authoring only: run with LibreOffice's Python, never during tests/runtime.

Creates original, redistributable test content using LibreOffice Impress's UNO API.
The committed .ppt/.pptx files allow tests to run without Office/LibreOffice/Python.
"""
from pathlib import Path
import base64
import subprocess
import time
import uno
from com.sun.star.beans import PropertyValue

ROOT = Path(__file__).resolve().parent
def prop(name, value):
    p = PropertyValue()
    p.Name, p.Value = name, value
    return p

process = subprocess.Popen([
    r"C:\Program Files\LibreOffice\program\soffice.com", "--headless",
    "-env:UserInstallation=file:///C:/Users/ASUS/AppData/Local/Temp/fudaner-presentation-fixtures",
    "--accept=socket,host=localhost,port=20107;urp;StarOffice.ComponentContext",
], creationflags=subprocess.CREATE_NO_WINDOW)
try:
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    for _ in range(60):
        try:
            context = resolver.resolve("uno:socket,host=localhost,port=20107;urp;StarOffice.ComponentContext")
            break
        except Exception:
            time.sleep(0.25)
    desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
    doc = desktop.loadComponentFromURL("private:factory/simpress", "_blank", 0, (prop("Hidden", True),))
    pages = doc.getDrawPages()
    first_page = True

    def page():
        global first_page
        slide = pages.getByIndex(0) if first_page else pages.insertNewByIndex(pages.getCount())
        first_page = False
        slide.Layout = 20  # blank
        while slide.getCount():
            slide.remove(slide.getByIndex(0))
        return slide

    def textbox(slide, text, x, y, width=20000, height=3000):
        shape = doc.createInstance("com.sun.star.drawing.TextShape")
        slide.add(shape)
        point = uno.createUnoStruct("com.sun.star.awt.Point")
        point.X, point.Y = x, y
        size = uno.createUnoStruct("com.sun.star.awt.Size")
        size.Width, size.Height = width, height
        shape.setPosition(point)
        shape.setSize(size)
        shape.setString(text)
        return shape

    first = page()
    textbox(first, "第一张：复旦课程", 1000, 1000)
    textbox(first, "中文 English café µ\n第二段", 1000, 6000)
    notes = first.getNotesPage()
    notes_shape = next((notes.getByIndex(i) for i in range(notes.getCount())
                        if notes.getByIndex(i).supportsService("com.sun.star.presentation.NotesShape")), None)
    if notes_shape is None:
        textbox(notes, "讲者备注：请介绍校园", 1000, 1000)
    else:
        notes_shape.setString("讲者备注：请介绍校园")

    second = page()
    textbox(second, "第二张：费用表", 1000, 1000)
    table = doc.createInstance("com.sun.star.drawing.TableShape")
    second.add(table)
    table.Model.Columns.insertByIndex(0, 1)
    table.Model.Rows.insertByIndex(0, 1)
    for r, row in enumerate([["项目", "金额"], ["咖啡", "12.50"]]):
        for c, value in enumerate(row):
            table.Model.getCellByPosition(c, r).setString(value)
    size = uno.createUnoStruct("com.sun.star.awt.Size")
    size.Width, size.Height = 20000, 7000
    table.setSize(size)

    page()  # Deliberately empty third slide.
    image_slide = page()
    png = ROOT / "presentation-pixel.png"
    png.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg=="))
    image = doc.createInstance("com.sun.star.drawing.GraphicObjectShape")
    image_slide.add(image)
    image.GraphicURL = uno.systemPathToFileUrl(str(png))
    image.setSize(size)
    for extension, filter_name in [("pptx", "Impress MS PowerPoint 2007 XML"), ("ppt", "MS PowerPoint 97")]:
        doc.storeToURL(uno.systemPathToFileUrl(str(ROOT / ("presentation-original." + extension))),
                       (prop("FilterName", filter_name), prop("Overwrite", True)))
    try:
        doc.close(True)
    except Exception:
        pass  # Some Windows headless builds dispose the bridge during close.
finally:
    process.terminate()
