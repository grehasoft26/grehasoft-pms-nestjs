import { Test, TestingModule } from '@nestjs/testing';
import { PdfService } from './pdf.service';

describe('PdfService', () => {
  let service: PdfService;
  const originalEnv = process.env;

  beforeEach(async () => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.PYTHON_BIN;
    delete process.env.PYTHON_PATH;

    const module: TestingModule = await Test.createTestingModule({
      providers: [PdfService],
    }).compile();

    service = module.get<PdfService>(PdfService);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should resolve a valid python executable on the current system', () => {
    const pythonExec = service.getPythonExecutable(true);
    expect(typeof pythonExec).toBe('string');
    expect(pythonExec.length).toBeGreaterThan(0);
  });

  it('should prioritize process.env.PYTHON_BIN if set and valid', () => {
    const validExec = service.getPythonExecutable(true);
    process.env.PYTHON_BIN = validExec;
    const resolved = service.getPythonExecutable(true);
    expect(resolved).toBe(validExec);
  });

  it('should prioritize custom PYTHON_BIN path like /opt/alt/python311/bin/python3.11 when valid', () => {
    const customBin = '/opt/alt/python311/bin/python3.11';
    process.env.PYTHON_BIN = customBin;
    jest
      .spyOn(service as any, 'isPythonExecutableValid')
      .mockImplementation((cmd) => cmd === customBin);
    const resolved = service.getPythonExecutable(true);
    expect(resolved).toBe(customBin);
  });

  it('should throw clear actionable error if no python binary is valid', () => {
    jest.spyOn(service as any, 'isPythonExecutableValid').mockReturnValue(false);
    expect(() => service.getPythonExecutable(true)).toThrowError(
      /Python executable not found/i,
    );
  });
});

