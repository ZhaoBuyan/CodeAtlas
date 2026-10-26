import importlib.util
import os

def load_annotations():
    module_path = os.path.join(os.path.dirname(__file__), 'pkg/dynamic.py')
    spec = importlib.util.spec_from_file_location('fixture_module', module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.DynRequest

DynRequest = load_annotations()

class DynamicUse:
    def make(self):
        DynRequest()
