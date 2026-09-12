import sys
import os
import json
import tempfile
import shutil
from num2words import num2words

from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.platypus import Paragraph, Table, TableStyle, Image, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

def setup_poppins_fonts():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    fonts_dir = os.path.join(script_dir, "fonts")
    
    reg_path = os.path.join(fonts_dir, "Poppins-Regular.ttf")
    med_path = os.path.join(fonts_dir, "Poppins-Medium.ttf")
    bold_path = os.path.join(fonts_dir, "Poppins-Bold.ttf")

    if os.path.exists(reg_path):
        pdfmetrics.registerFont(TTFont("Poppins", reg_path))
    if os.path.exists(med_path):
        pdfmetrics.registerFont(TTFont("Poppins-Medium", med_path))
    if os.path.exists(bold_path):
        pdfmetrics.registerFont(TTFont("Poppins-Bold", bold_path))

def find_asset(media_root, filename):
    paths = [
        os.path.join(media_root, filename),
        os.path.join(media_root, "logo", filename),
        os.path.join(media_root, "icons", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "media", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "media", "logo", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "media", "icons", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "grehasoft-pythonpms", "backend", "media", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "grehasoft-pythonpms", "backend", "media", "logo", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "grehasoft-pythonpms", "backend", "media", "icons", filename)
    ]
    for p in paths:
        if os.path.exists(p):
            return p
    return None

class MockClient:
    def __init__(self, data):
        self.company_name = data.get('company_name') or ''
        self.name = data.get('name') or data.get('client_name') or ''
        self.email = data.get('email') or ''
        self.phone = data.get('phone') or ''
        self.address = data.get('address') or ''
        self.gst_no = data.get('gst_no') or data.get('gst_number') or ''

class MockItem:
    def __init__(self, item):
        self.description = item.get('description', '')
        self.quantity = item.get('quantity', 1)
        self.rate = float(item.get('rate', 0.0))
        self.amount = float(item.get('amount', 0.0))

class MockItemsList:
    def __init__(self, items):
        self._items = [MockItem(i) for i in items]
    def all(self):
        return self._items

class MockPayment:
    def __init__(self, pay):
        self.payment_date = str(pay.get('payment_date', ''))
        self.amount = float(pay.get('amount', 0.0))
        self.payment_mode = pay.get('payment_mode', 'cash')
        self.notes = pay.get('notes', '')

class MockPaymentsQuerySet:
    def __init__(self, payments):
        self._payments = [MockPayment(p) for p in payments]
    def all(self):
        return self
    def order_by(self, field):
        return self._payments
    def exists(self):
        return len(self._payments) > 0
    def __len__(self):
        return len(self._payments)
    def __iter__(self):
        return iter(self._payments)

class MockInvoice:
    def __init__(self, data):
        self.id = data.get('id')
        self.invoice_number = data.get('invoice_number') or data.get('invoiceNumber') or 'INV-001'
        self.issue_date = str(data.get('issue_date') or data.get('issueDate') or '')
        raw_due_date = data.get('due_date') if data.get('due_date') is not None else data.get('dueDate')
        if raw_due_date and str(raw_due_date).strip() and str(raw_due_date).strip().lower() not in ('none', 'null', 'undefined'):
            self.due_date = str(raw_due_date).strip()
        else:
            self.due_date = None
        self.status = str(data.get('status') or 'unpaid')
        self.subtotal = float(data.get('subtotal', 0.0))
        self.tax = float(data.get('tax', 0.0))
        self.total = float(data.get('total', 0.0))
        self.advance = float(data.get('advance', 0.0))
        self.total_paid = float(data.get('total_paid') or data.get('totalPaid') or 0.0)
        self.balance = float(data.get('balance', 0.0))
        
        client_data = data.get('client') or {}
        if not isinstance(client_data, dict):
            client_data = {}
        if not client_data.get('name') and data.get('client_name'):
            client_data['name'] = data.get('client_name')
        if not client_data.get('phone') and data.get('client_phone'):
            client_data['phone'] = data.get('client_phone')
        client_address_inv = data.get('client_address')
        if client_address_inv is not None and str(client_address_inv).strip():
            client_data['address'] = client_address_inv
        self.client = MockClient(client_data)
        
        items_data = data.get('items', [])
        self.items = MockItemsList(items_data)
        
        payments_data = data.get('payments', [])
        self.payments = MockPaymentsQuerySet(payments_data)

def draw_watermark(canvas_obj, width, height, media_root):
    watermark_path = find_asset(media_root, "grehasoftwatermark.png")
    if watermark_path and os.path.exists(watermark_path):
        canvas_obj.saveState()
        try:
            canvas_obj.setFillAlpha(0.15)
            canvas_obj.setStrokeAlpha(0.15)
        except AttributeError:
            pass
        
        try:
            from PIL import Image as PILImage
            img = PILImage.open(watermark_path)
            img_w, img_h = img.size
            
            draw_w = width * 0.65
            scale = draw_w / img_w
            draw_h = img_h * scale
            
            if draw_h > height * 0.65:
                draw_h = height * 0.65
                scale = draw_h / img_h
                draw_w = img_w * scale
            
            x = (width - draw_w) / 2.0
            y = (height - draw_h) / 2.0
            
            watermark = ImageReader(watermark_path)
            canvas_obj.drawImage(watermark, x, y, width=draw_w, height=draw_h, preserveAspectRatio=True, mask='auto')
        except Exception as e:
            print("Watermark draw error:", e, file=sys.stderr)
        canvas_obj.restoreState()

def generate_invoice_pdf(invoice, media_root=""):
    setup_poppins_fonts()
    tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")

    # 1️⃣ Create canvas FIRST
    p = canvas.Canvas(tmp_file.name, pagesize=A4)
    width, height = A4

    # Watermark background
    draw_watermark(p, width, height, media_root)

    # 2️⃣ Then draw header
    header_path = find_asset(media_root, "invoice_header.png")
    if header_path and os.path.exists(header_path):
        try:
            header = ImageReader(header_path)
            img_w, img_h = header.getSize()
            header_h = width * (float(img_h) / float(img_w))
            p.drawImage(header, -4, height - header_h + 4, width=width + 8, height=header_h, preserveAspectRatio=True)
        except Exception as e:
            print("Header image error:", e, file=sys.stderr)

    # 3️⃣ Start content lower because header occupies space
    y = height - 122

    # -----------------------------
    # COMPANY INFO / TITLE
    # -----------------------------
    p.setFont("Poppins-Bold", 16)
    p.drawCentredString(width/2, y, "INVOICE BILL")
    y -= 25

    # -----------------------------
    # INVOICE INFO HEADER
    # -----------------------------
    p.setFont("Poppins", 10)
    p.drawString(65, y, f"Invoice No : {invoice.invoice_number}")
    p.drawString(65, y - 16, f"Issue Date : {invoice.issue_date}")
    if invoice.due_date:
        p.drawString(65, y - 32, f"Due Date : {invoice.due_date}")
        y -= 48
    else:
        y -= 32

    # Top separator line
    p.setStrokeColor(colors.HexColor("#e2e8f0"))
    p.setLineWidth(1)
    p.line(65, y, width - 65, y)
    y -= 15

    # -----------------------------
    # BILL TO PANEL
    # -----------------------------
    styles = getSampleStyleSheet()
    content_style = ParagraphStyle(
        'PanelContent',
        parent=styles['Normal'],
        fontName='Poppins',
        fontSize=10,
        leading=14
    )

    client = invoice.client
    bill_to_lines = []
    if client.company_name and client.company_name.strip() != (client.name or "").strip():
        bill_to_lines.append(f"<b>{client.company_name}</b>")
    if client.name:
        bill_to_lines.append(f"{client.name}")
    if client.email:
        bill_to_lines.append(f"Email: {client.email}")
    if client.address:
        addr_clean = client.address.replace("\n", "<br/>").replace("\r", "")
        bill_to_lines.append(f"{addr_clean}")
    if client.gst_no:
        bill_to_lines.append(f"GSTIN: {client.gst_no}")

    bill_to_html = "<br/>".join(bill_to_lines) if bill_to_lines else "Valued Client"

    bill_to_cell = Paragraph(f"<font color='#1f4e79'><b>BILL TO:</b></font><br/><br/>{bill_to_html}", content_style)

    info_table = Table([[bill_to_cell]], colWidths=[465])
    info_table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
    ]))

    iw, ih = info_table.wrap(465, height)
    info_table.drawOn(p, 65, y - ih)
    y = y - ih - 15

    # Bottom separator line
    p.line(65, y, width - 65, y)
    y -= 20

    # -----------------------------
    # TABLE DATA
    # -----------------------------
    desc_style = ParagraphStyle(
        'ItemDescription',
        parent=styles['Normal'],
        fontName='Poppins',
        fontSize=10,
        leading=13,
        textColor=colors.black
    )

    data = [
        ["Description of Services", "Amount"]
    ]

    subtotal = 0.0

    items_list = invoice.items.all()
    for item in items_list:
        subtotal += float(item.amount)
        desc_text = str(item.description or '').replace('\n', '<br/>')
        data.append([
            Paragraph(desc_text, desc_style) if desc_text else "",
            f"₹ {item.amount:,.2f}"
        ])

    if not items_list:
        subtotal = invoice.subtotal or invoice.total or 0.0
        data.append([
            Paragraph("Professional Services", desc_style),
            f"₹ {subtotal:,.2f}"
        ])

    # -----------------------------
    # SUMMARY ROWS
    # -----------------------------
    subtotal_row_idx = len(data)
    data.append(["Sub Total", f"₹ {subtotal:,.2f}"])

    tax_val = float(getattr(invoice, 'tax', 0.0) or 0.0)
    gst_row_idx = None
    if round(tax_val, 2) > 0:
        gst_row_idx = len(data)
        data.append(["GST", f"₹ {tax_val:,.2f}"])

    total_val = float(getattr(invoice, 'total', 0.0) or 0.0)
    discount_amount = max(subtotal + tax_val - total_val, 0.0)
    discount_row_idx = None
    if round(discount_amount, 2) > 0:
        discount_row_idx = len(data)
        data.append(["Discount", f"-₹ {discount_amount:,.2f}"])

    grand_total_row_idx = len(data)
    data.append(["Grand Total", f"₹ {total_val:,.2f}"])

    paid_val = float(getattr(invoice, 'total_paid', 0.0) or 0.0)
    amount_paid_row_idx = None
    if round(paid_val, 2) > 0:
        advance_val = float(getattr(invoice, 'advance', 0.0) or 0.0)
        payments_prop = getattr(invoice, 'payments', [])
        if hasattr(payments_prop, 'exists'):
            has_subsequent_payments = payments_prop.exists()
        elif hasattr(payments_prop, 'all'):
            p_all = payments_prop.all()
            if hasattr(p_all, 'exists'):
                has_subsequent_payments = p_all.exists()
            else:
                has_subsequent_payments = len(p_all) > 0
        else:
            has_subsequent_payments = len(payments_prop or []) > 0

        if advance_val > 0 and not has_subsequent_payments:
            payment_label = "Advance Received"
        else:
            payment_label = "Amount Paid"

        amount_paid_row_idx = len(data)
        data.append([payment_label, f"₹ {paid_val:,.2f}"])

    balance_val = float(getattr(invoice, 'balance', 0.0) or 0.0)
    balance_due_row_idx = None
    if round(balance_val, 2) > 0 and round(balance_val, 2) != round(total_val, 2):
        balance_due_row_idx = len(data)
        data.append(["Balance Due", f"₹ {balance_val:,.2f}"])

    # -----------------------------
    # TABLE STYLING
    # -----------------------------
    table = Table(data, colWidths=[355, 110])
    
    items_count = len(items_list) if items_list else 1
    table_styles = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, items_count), 1, colors.grey),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f4e79")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Poppins-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("FONTNAME", (0, 1), (-1, items_count), "Poppins"),
        ("ALIGN", (1, 1), (1, items_count), "RIGHT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
    ]

    # Style summary rows
    table_styles.append(("FONTNAME", (0, subtotal_row_idx), (1, subtotal_row_idx), "Poppins"))
    
    if gst_row_idx is not None:
        table_styles.append(("FONTNAME", (0, gst_row_idx), (1, gst_row_idx), "Poppins"))

    if discount_row_idx is not None:
        table_styles.append(("FONTNAME", (0, discount_row_idx), (1, discount_row_idx), "Poppins"))

    table_styles.extend([
        ("FONTNAME", (0, grand_total_row_idx), (1, grand_total_row_idx), "Poppins-Bold"),
        ("LINEABOVE", (0, grand_total_row_idx), (1, grand_total_row_idx), 1, colors.grey),
    ])

    if amount_paid_row_idx is not None:
        table_styles.append(("FONTNAME", (0, amount_paid_row_idx), (1, amount_paid_row_idx), "Poppins"))

    if balance_due_row_idx is not None:
        table_styles.extend([
            ("FONTNAME", (0, balance_due_row_idx), (1, balance_due_row_idx), "Poppins-Bold"),
            ("LINEABOVE", (0, balance_due_row_idx), (1, balance_due_row_idx), 1, colors.grey),
            ("LINEBELOW", (0, balance_due_row_idx), (1, balance_due_row_idx), 1.5, colors.grey),
            ("BACKGROUND", (0, balance_due_row_idx), (1, balance_due_row_idx), colors.HexColor("#fff3cd")),
            ("TEXTCOLOR", (0, balance_due_row_idx), (1, balance_due_row_idx), colors.HexColor("#856404")),
        ])

    table_styles.append(("ALIGN", (0, subtotal_row_idx), (1, -1), "RIGHT"))
    table.setStyle(TableStyle(table_styles))

    w, h = table.wrap(465, height)
    if y - h < 120:
        p.showPage()
        draw_watermark(p, width, height, media_root)
        y = height - 80
        w, h = table.wrap(465, height)

    table.drawOn(p, 65, y - h)
    y = y - h - 15

    # -----------------------------
    # AMOUNT IN WORDS
    # -----------------------------
    grand_total_val = float(getattr(invoice, 'total', 0.0) or 0.0)
    balance_val = float(getattr(invoice, 'balance', 0.0) or 0.0)

    if round(balance_val, 2) > 0 and round(balance_val, 2) < round(grand_total_val, 2):
        amount_for_words = balance_val
    else:
        amount_for_words = grand_total_val

    rupees = int(amount_for_words)
    paise = int(round((amount_for_words - rupees) * 100))

    try:
        amount_words = num2words(rupees, lang="en_IN").replace(",", "")
    except Exception:
        amount_words = str(rupees)

    if paise > 0:
        try:
            paise_words = num2words(paise, lang="en_IN")
        except Exception:
            paise_words = str(paise)
        final_words = f"Rupees {amount_words.title()} and {paise_words.title()} Paise Only."
    else:
        final_words = f"Rupees {amount_words.title()} Only."

    p.saveState()
    p.setFont("Poppins", 11)
    p.setFillColor(colors.HexColor("#1f4e79"))
    p.drawString(65, y, f"Net Amount (in words): {final_words}")
    p.restoreState()
    y -= 30

    # -----------------------------
    # DYNAMIC FOOTER TABLE
    # -----------------------------
    footer_style = ParagraphStyle(
        'FooterStyle',
        parent=styles['Normal'],
        fontName='Poppins',
        fontSize=11,
        leading=15,
        textColor=colors.black
    )

    seal_flowable = None
    seal_path = find_asset(media_root, "seal.png") or find_asset(media_root, "seal.jpeg")
    if seal_path and os.path.exists(seal_path):
        try:
            seal_img = ImageReader(seal_path)
            img_w, img_h = seal_img.getSize()
            aspect = img_w / float(img_h)
            target_w = 90
            target_h = target_w / aspect
            seal_flowable = Image(seal_path, width=target_w, height=target_h)
        except Exception as e:
            print("Seal image error:", e, file=sys.stderr)

    pan_html = "PAN: <b>AXMPP3677M</b>"

    bank_html = (
        "<u><b>Bank Details</b></u><br/>"
        "Account Name - GREHASOFT<br/>"
        "Bank Name - SBI<br/>"
        "Account Number - 4159 7828 369<br/>"
        "IFSC code - SBIN0018060"
    )

    upi_html = "UPI ID: <b>grehasoft@sbi</b>"

    left_footer_flowable = Paragraph(f"{pan_html}<br/><br/>{bank_html}<br/>{upi_html}", footer_style)

    left_cell_content = []
    if seal_flowable:
        left_cell_content.append(seal_flowable)
        left_cell_content.append(Spacer(1, 4))
    left_cell_content.append(left_footer_flowable)

    qr_flowable = None
    qr_path = find_asset(media_root, "scanpay.jpeg")
    try:
        if qr_path and os.path.exists(qr_path):
            qr_flowable = Image(qr_path, width=140, height=182)
    except Exception as e:
        print("QR image error:", e, file=sys.stderr)

    qr_upi_style = ParagraphStyle(
        'QRUPIStyle',
        parent=footer_style,
        fontName='Poppins-Bold',
        fontSize=9,
        alignment=2
    )
    qr_upi_paragraph = Paragraph("<b>UPI ID: grehasoft@sbi</b>", qr_upi_style)

    right_cell_content = []
    if qr_flowable:
        right_cell_content.append(qr_flowable)
    else:
        right_cell_content.append(qr_upi_paragraph)

    footer_table = Table([[left_cell_content, right_cell_content]], colWidths=[255, 210])
    footer_table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('ALIGN', (1, 0), (1, 0), 'RIGHT'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
    ]))

    fw, fh = footer_table.wrap(465, height)
    if y - fh < 60:
        p.showPage()
        draw_watermark(p, width, height, media_root)
        y = height - 60

    footer_table.drawOn(p, 65, y - fh)
    y = y - fh - 12

    if invoice.due_date:
        note_style = ParagraphStyle(
            'NoteStyle',
            parent=styles['Normal'],
            fontName='Poppins-Bold',
            fontSize=9.5,
            leading=13,
            textColor=colors.HexColor("#334155")
        )
        note_paragraph = Paragraph("<b>Note: Interest may be charged on delayed payments as per the agreed payment terms.</b>", note_style)
        nw, nh = note_paragraph.wrap(465, height)
        note_paragraph.drawOn(p, 65, y - nh)
        y = y - nh

    p.save()

    return tmp_file.name

def main():
    if len(sys.argv) < 3:
        print("Usage: python generate_invoice_pdf.py <json_input_file> <output_pdf_file>", file=sys.stderr)
        sys.exit(1)
        
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    with open(input_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
        
    invoice_data = data.get('invoice', {})
    media_root = data.get('media_root', '')
    
    mock_invoice = MockInvoice(invoice_data)
    pdf_temp_path = generate_invoice_pdf(mock_invoice, media_root=media_root)
    
    shutil.copyfile(pdf_temp_path, output_file)
    try:
        os.remove(pdf_temp_path)
    except Exception:
        pass
    print("SUCCESS")

if __name__ == '__main__':
    main()
